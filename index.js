import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import db from './db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(express.json()); // Permite recibir datos en formato JSON

// --- ENDPOINT: INICIO DE SESIÓN ---
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;

  try {
    // Buscamos el usuario en la base de datos
    const [rows] = await db.query(
      'SELECT id, usuario, nombre_completo, rol FROM usuarios WHERE usuario = ? AND password = ?',
      [usuario, password]
    );

    if (rows.length > 0) {
      // Login exitoso: devolvemos los datos del agente (menos la contraseña)
      res.json({ loginExitoso: true, usuario: rows[0] });
    } else {
      res.status(401).json({ loginExitoso: false, mensaje: 'Credenciales inválidas' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error en el servidor al intentar loguear' });
  }
});

// --- ENDPOINT: CONSULTA DE DOMINIO ---
app.post('/api/vehiculos/consulta', async (req, res) => {
  const { dominio, usuarioId } = req.body; // Recibimos el dominio y el ID del agente que busca

  try {
    const patenteLimpia = dominio.replace(/\s+/g, '').toUpperCase();

    // 1. Buscamos el vehículo y su impedimento activo haciendo un JOIN
    const [vehiculoRows] = await db.query(
      `SELECT v.id, v.dominio, v.marca, v.modelo, v.anio, v.tipo, v.numero_chasis, v.numero_motor, v.color, v.titular_nombre, v.titular_dni, i.tipo_impedimento, i.detalle 
    FROM vehiculos v
       LEFT JOIN impedimentos i ON v.id = i.vehiculo_id AND i.activo = true
       WHERE v.dominio = ?`,
      [patenteLimpia]
    );

    let resultadoConsulta = {};

    if (vehiculoRows.length > 0) {
      const v = vehiculoRows[0];
      
      // SALVAVIDAS: Si tipo_impedimento es nulo (no tiene robos), le ponemos "SIN IMPEDIMENTOS"
      const estadoImpedimento = v.tipo_impedimento || 'SIN IMPEDIMENTOS';
      
      // Mapeamos TODOS los datos (incluidos los nuevos) para el Frontend
      resultadoConsulta = {
        encontrado: true,
        estado: estadoImpedimento === 'SIN IMPEDIMENTOS' ? 'verde' : 'rojo',
        titulo: estadoImpedimento,
        marca: v.marca,
        modelo: v.modelo,
        anio: v.anio,
        tipo: v.tipo,
        color: v.color,
        titular_nombre: v.titular_nombre,
        titular_dni: v.titular_dni,
        numero_chasis: v.numero_chasis,
        numero_motor: v.numero_motor,
        icono: estadoImpedimento === 'SIN IMPEDIMENTOS' ? '✔️' : '⚠️'
      };
    } else {
      // Si el vehículo no figura en el registro general
      resultadoConsulta = {
        encontrado: false,
        estado: 'gris',
        titulo: 'SIN REGISTRO EN SISTEMA',
        marca: 'Desconocida',
        modelo: 'No identificado',
        anio: '-',
        tipo: '-',
        icono: '❓'
      };
    }

    // 2. AUDITORÍA OBLIGATORIA: Guardamos el registro de quién consultó esta patente
    await db.query(
      'INSERT INTO historial_consultas (dominio_consultado, estado_resultado, usuario_id) VALUES (?, ?, ?)',
      [patenteLimpia, resultadoConsulta.titulo, usuarioId]
    );

    // Devolvemos el resultado al frontend
    res.json(resultadoConsulta);

  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al procesar la consulta operativa' });
  }
});
// --- ENDPOINT: TRAER TODOS LOS VEHÍCULOS (PARA IMPRESIÓN MASIVA) ---
app.get('/api/vehiculos/todos', async (req, res) => {
  try {
    const [vehiculos] = await db.query(
      `SELECT v.*, i.tipo_impedimento 
       FROM vehiculos v 
       LEFT JOIN impedimentos i ON v.id = i.vehiculo_id AND i.activo = true`
    );
    res.json(vehiculos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al obtener el listado masivo' });
  }
});

// --- ENDPOINT: BUSCAR PERSONA POR DNI ---
app.get('/api/personas/:dni', async (req, res) => {
  try {
    const dniBuscado = req.params.dni;
    const [resultados] = await db.query(
      'SELECT * FROM personas WHERE dni = ?',
      [dniBuscado]
    );

    if (resultados.length > 0) {
      res.json(resultados[0]); // Mandamos los datos de la persona al frontend
    } else {
      res.status(404).json({ mensaje: 'No se encontraron registros para este DNI.' });
    }
  } catch (error) {
    console.error("Error buscando persona:", error);
    res.status(500).json({ mensaje: 'Error interno del servidor.' });
  }
});

// Levantar el servidor
app.listen(PORT, () => {
  console.log(`Servidor SCIP corriendo en el puerto ${PORT}`);
});
// --- ENDPOINT: LISTADO GENERAL DE PERSONAS ---
app.get('/api/personas', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM personas');
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener el listado:', error);
    res.status(500).json({ mensaje: 'Error al obtener el listado de personas' });
  }
});
// --- ENDPOINT: BUSCAR PERSONA POR DNI (PEDIDO DE CAPTURA) ---
app.get('/api/personas/:dni', async (req, res) => {
  const { dni } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM personas WHERE dni = ?', [dni]);
    
    if (rows.length === 0) {
      // Si no existe en el registro policial
      return res.status(404).json({ mensaje: 'Ciudadano no registrado en el sistema' });
    }
    
    // Devolvemos los datos completos (incluyendo si tiene captura o no)
    res.json(rows[0]);
  } catch (error) {
    console.error("Error al buscar persona:", error);
    res.status(500).json({ mensaje: 'Error interno del servidor' });
  }
});
// --- ENDPOINT: TRAER HISTORIAL DE CONSULTAS ---
app.get('/api/historial', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT h.id, h.fecha_hora, h.dominio_consultado, h.estado_resultado, u.nombre_completo AS operador
      FROM historial_consultas h
      JOIN usuarios u ON h.usuario_id = u.id
      ORDER BY h.fecha_hora DESC
      LIMIT 5
    `);
    res.json(rows);
  } catch (error) {
    console.error("Error al obtener historial:", error);
    res.status(500).json({ mensaje: 'Error interno del servidor' });
  }
});
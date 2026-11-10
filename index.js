import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 4000;

// Registro de salas activas en memoria
const rooms = new Map();

// Endpoint de diagnóstico y keepalive (para evitar que servicios gratuitos se duerman)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ping', (req, res) => {
  res.json({ pong: true, time: Date.now() });
});

// Página básica informativa si abren el Relay en un navegador
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>RemoteDesk Relay Server</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #171717; border: 1px solid #262626; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; background: rgba(34, 197, 94, 0.15); color: #22c55e; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
        h1 { margin: 0 0 8px; font-size: 24px; }
        p { color: #a3a3a3; font-size: 14px; line-height: 1.5; }
        .stats { margin-top: 24px; padding-top: 16px; border-top: 1px solid #262626; font-size: 13px; color: #737373; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">● SERVIDOR RELAY EN LÍNEA</span>
        <h1>RemoteDesk Cloud Broker</h1>
        <p>Este nodo actúa como puente de señalización para conectar dispositivos a través de Internet sin necesidad de abrir puertos.</p>
        <div class="stats">
          Salas activas: <strong>${rooms.size}</strong> &bull; Modo: <strong>Producción</strong>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Gestión de conexiones WebSockets
io.on('connection', (socket) => {
  let joinedRoom = null;
  let isCurrentHost = false;

  // 1. Registro de Sala (Host o Cliente)
  socket.on('join-room', (data) => {
    const { roomID, isHost, password } = typeof data === 'string' 
      ? { roomID: data, isHost: false, password: '' } 
      : data;

    if (!roomID) return;
    // Normalizar ID quitando espacios para soportar formato '482 915 730' o '482915730'
    const id = roomID.toString().replace(/\s+/g, '').toUpperCase().trim();
    joinedRoom = id;
    isCurrentHost = !!isHost;

    if (isHost) {
      // El Host registra o actualiza su presencia
      const existing = rooms.get(id);
      rooms.set(id, {
        hostId: socket.id,
        password: password || existing?.password || '',
        createdAt: existing?.createdAt || Date.now(),
        lastActive: Date.now()
      });
      socket.join(id);
      socket.emit('host-ready', { roomID: id });
      console.log(`[Host Conectado] Sala ${id} registrada con clave: ${password ? '***' : 'Ninguna'} (Socket: ${socket.id})`);
    } else {
      // El Cliente intenta unirse
      const room = rooms.get(id);
      if (!room) {
        socket.emit('room-not-found', { roomID: id, message: 'La computadora host no está conectada o el ID no existe' });
        return;
      }

      if (room.password && room.password !== password) {
        socket.emit('auth-required', { roomID: id, message: 'Contraseña incorrecta' });
        return;
      }

      socket.join(id);
      room.lastActive = Date.now();
      // Conexión autorizada sin requerir aceptación manual
      socket.emit('client-connected', { roomID: id });
      socket.to(room.hostId).emit('client-connected', { id: socket.id, unattended: true });
      console.log(`[Cliente Conectado] Se unió a la sala ${id} sin requerir confirmación (Socket: ${socket.id})`);
    }
  });

  // 2. Actualización de Contraseña
  socket.on('update-password', (data) => {
    if (!data?.roomID) return;
    const id = data.roomID.toString().replace(/\s+/g, '').toUpperCase().trim();
    const room = rooms.get(id);
    if (room && room.hostId === socket.id) {
      room.password = data.password || '';
      socket.to(id).emit('security-updated', { hasPassword: !!room.password });
      console.log(`[Seguridad Actualizada] Nueva clave para sala ${id}`);
    }
  });

  // 3. Retransmisión de Eventos Periféricos (Cliente -> Host)
  const forwardToHost = (event, payload) => {
    if (!payload?.roomID) return;
    const id = payload.roomID.toUpperCase().trim();
    const room = rooms.get(id);
    if (room?.hostId) {
      room.lastActive = Date.now();
      socket.to(room.hostId).emit(event, payload);
    }
  };

  socket.on('mouse-move', (data) => forwardToHost('mouse-move', data));
  socket.on('mouse-move-abs', (data) => forwardToHost('mouse-move-abs', data));
  socket.on('mouse-click', (data) => forwardToHost('mouse-click', data));
  socket.on('mouse-click-abs', (data) => forwardToHost('mouse-click-abs', data));
  socket.on('mouse-toggle', (data) => forwardToHost('mouse-toggle', data));
  socket.on('mouse-scroll', (data) => forwardToHost('mouse-scroll', data));
  socket.on('type-text', (data) => forwardToHost('type-text', data));
  socket.on('key-event', (data) => forwardToHost('key-event', data));
  socket.on('screen-start', (data) => forwardToHost('screen-start', data));
  socket.on('screen-stop', (data) => forwardToHost('screen-stop', data));

  // 4. Retransmisión de Pantalla en Vivo (Host -> Clientes)
  socket.on('screen-frame', (data) => {
    if (!data?.roomID) return;
    const id = data.roomID.toUpperCase().trim();
    socket.to(id).emit('screen-frame', data);
  });

  // 5. Retransmisión de Archivos por Socket (Bidireccional)
  socket.on('file-chunk-start', (data) => forwardToHost('file-chunk-start', data));
  socket.on('file-chunk-data', (data) => forwardToHost('file-chunk-data', data));
  socket.on('file-chunk-complete', (data) => forwardToHost('file-chunk-complete', data));
  socket.on('file-list-req', (data) => forwardToHost('file-list-req', data));
  socket.on('file-list-res', (data) => {
    if (!data?.roomID) return;
    socket.to(data.roomID.toUpperCase().trim()).emit('file-list-res', data);
  });

  // 6. Retransmisión de Portapapeles (Bidireccional)
  socket.on('clipboard-update', (data) => {
    if (!data?.roomID) return;
    const id = data.roomID.toUpperCase().trim();
    socket.to(id).emit('clipboard-received', data);
  });

  // 5. Desconexión
  socket.on('disconnect', () => {
    if (joinedRoom) {
      const room = rooms.get(joinedRoom);
      if (room) {
        if (room.hostId === socket.id) {
          console.log(`[Host Desconectado] Sala ${joinedRoom} cerrada`);
          socket.to(joinedRoom).emit('host-disconnected', { roomID: joinedRoom });
          rooms.delete(joinedRoom);
        } else {
          console.log(`[Cliente Desconectado] de la sala ${joinedRoom}`);
          socket.to(room.hostId).emit('client-disconnected', { id: socket.id });
        }
      }
    }
  });
});

// Limpieza automática cada 30 min de salas inactivas (más de 2 horas)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (now - room.lastActive > 2 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 30 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`\n🌐 [RemoteDesk Relay] Activo en puerto ${PORT}`);
  console.log(`   - Health check: http://localhost:${PORT}/health\n`);
});


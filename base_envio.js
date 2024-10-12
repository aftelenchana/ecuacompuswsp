const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json()); // Permite el uso de JSON en las peticiones POST

const sessions = {}; // Almacenamos las sesiones en un objeto

// Función para crear una nueva sesión de WhatsApp
async function createSession(sessionId) {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // No imprimir el QR en la terminal
    });

    // Si el QR está disponible, lo generamos
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        if (qr) {
            // Generamos el QR como imagen y lo guardamos
            const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);
            await qrcode.toFile(qrCodePath, qr);
        } else if (connection === 'open') {
            console.log(`Conexión abierta para la sesión ${sessionId}`);
        }
    });

    // Guardar la sesión en la variable global
    sessions[sessionId] = sock;

    // Guardar las credenciales
    sock.ev.on('creds.update', saveCreds);
}

// Endpoint para iniciar una nueva sesión (POST)
app.post('/start-session', async (req, res) => {
    const { sessionId } = req.body; // Obtener el sessionId del cuerpo de la solicitud

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido en el cuerpo de la solicitud.');
    }

    if (sessions[sessionId]) {
        return res.status(400).send('Esta sesión ya está activa.');
    }

    // Crear la sesión
    await createSession(sessionId);

    // Retornar la URL del QR generado
    const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);
    if (fs.existsSync(qrCodePath)) {
        const qrCodeUrl = `http://localhost:3000/qrcodes/${sessionId}.png`;
        res.send(`Sesión iniciada. Escanea el código QR aquí: <a href="${qrCodeUrl}">${qrCodeUrl}</a>`);
    } else {
        res.status(500).send('Error al generar el código QR.');
    }
});

// Endpoint para enviar mensajes utilizando una sesión específica (POST)
app.post('/send-message', (req, res) => {
    const { sessionId, to, message } = req.body; // Obtener los parámetros del cuerpo de la solicitud

    if (!sessionId || !to || !message) {
        return res.status(400).send('sessionId, to y message son requeridos en el cuerpo de la solicitud.');
    }

    const session = sessions[sessionId];
    
    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    session.sendMessage(`${to}@s.whatsapp.net`, { text: message })
        .then(() => res.send('Mensaje enviado correctamente.'))
        .catch(err => res.status(500).send('Error al enviar el mensaje: ' + err.message));
});

// Servir los QR codes generados como imágenes estáticas
app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));

// Iniciar el servidor en el puerto 3000
app.listen(3000, () => {
    console.log('Servidor ejecutándose en el puerto 3000');
});

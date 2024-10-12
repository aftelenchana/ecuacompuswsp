const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Asegúrate de tener axios instalado

// Crear el store para almacenar contactos (declararlo globalmente)
const store = makeInMemoryStore({});

// Vincular el almacenamiento del store a un archivo (opcional, si quieres persistir datos entre reinicios)
store.readFromFile('./baileys_store.json');

// Guardar el store periódicamente en el archivo
setInterval(() => {
    store.writeToFile('./baileys_store.json');
}, 10_000);

const app = express();
app.use(express.json());

// Almacenar las sesiones en un objeto
const sessions = {};

// Función para crear una nueva sesión de WhatsApp
async function createSession(sessionId) {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        // Vincular el almacenamiento (store) a la sesión
        store,
    });

    // Enlazar los eventos de la sesión con el store
    store.bind(sock.ev);

    sock.connectionStatus = "inactiva"; // Estado por defecto

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);
            await qrcode.toFile(qrCodePath, qr);
        }

        if (connection === 'open') {
            sock.connectionStatus = "activa"; // Actualizar estado a activa
            console.log(`Conexión abierta para la sesión ${sessionId}`);
        } else if (connection === 'close') {
            sock.connectionStatus = "inactiva"; // Actualizar estado a inactiva
            const shouldReconnect = (lastDisconnect.error = Boom)?.output?.statusCode !== 401;
            console.log(`Conexión cerrada para la sesión ${sessionId}. Reintentando...`);
            if (shouldReconnect) {
                await createSession(sessionId);
            }
        }
    });

       // Escuchar mensajes entrantes

// Escuchar mensajes entrantes
sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && msg.message) {
        const from = msg.key.remoteJid; // JID del remitente
        const messageContent = msg.message.conversation || msg.message?.text || '';

        // Comprobar si el mensaje es 'hola'
        if (messageContent.toLowerCase() === 'hola') {
            let foundContact = false;
            let sessionIdFound = null;

            // Verificar si el número está en los contactos de todas las sesiones activas
            for (const [sessionId, session] of Object.entries(sessions)) {
                const contact = store.contacts[from];

                if (contact) {
                    foundContact = true;
                    sessionIdFound = sessionId; // Guardar la sesión donde se encontró el contacto
                    break; // Salir del bucle al encontrar el contacto
                }
            }

            if (foundContact) {
                // Responder con el número de sesión donde se encontró el contacto
                const response = `Hola, estoy en la sesión ${sessionIdFound}. ¿En qué puedo ayudarte?`;
                await sock.sendMessage(from, { text: response });
            } else {
                // Responder si no se encontró el contacto en ninguna sesión
                await sock.sendMessage(from, { text: 'Hola, no te tengo en mis contactos.' });
            }
        }

        if (messageContent.startsWith('guibis ')) {
            // Extraer el número de identificación
            const identificacion = messageContent.split(' ')[1];
        
            // Comprobar si se proporcionó un número de identificación
            if (identificacion) {
                try {
                    // Llamar a la API
                    const response = await axios.post('https://guibis.com/dev/wspguibis/', {
                        identificacion: identificacion.trim()
                    });
        
                    // Obtener el array de mensajes de la respuesta
                    const mensajes = response.data?.mensajes || ['No existen datos en Guibis.'];
        
                    // Unir los mensajes en una sola cadena
                    const mensajeFinal = mensajes.join('\n'); // Unir con un salto de línea entre mensajes
        
                    // Enviar la respuesta de la API
                    await sock.sendMessage(from, { text: mensajeFinal });
                } catch (error) {
                    console.error('Error al consumir la API:', error);
                    const errorMessage = error.response?.data?.mensaje || 'Error al consultar la API. Inténtalo más tarde.';
                    await sock.sendMessage(from, { text: errorMessage });
                }
            } else {
                await sock.sendMessage(from, { text: 'Por favor, proporciona un número de identificación válido.' });
            }
        }

        if (messageContent.startsWith('lgcontaduria ')) {
            // Extraer el número de identificación
            const identificacion = messageContent.split(' ')[1];
        
            // Comprobar si se proporcionó un número de identificación
            if (identificacion) {
                try {
                    // Llamar a la API
                    const response = await axios.post('https://guibis.com/dev/wspguibis/', {
                        identificacion: identificacion.trim()
                    });
        
                    // Obtener el array de mensajes de la respuesta
                    const mensajes = response.data?.mensajes || ['No existen datos en Guibis.'];
        
                    // Unir los mensajes en una sola cadena
                    const mensajeFinal = mensajes.join('\n'); // Unir con un salto de línea entre mensajes
        
                    // Enviar la respuesta de la API
                    await sock.sendMessage(from, { text: mensajeFinal });
                } catch (error) {
                    console.error('Error al consumir la API:', error);
                    const errorMessage = error.response?.data?.mensaje || 'Error al consultar la API. Inténtalo más tarde.';
                    await sock.sendMessage(from, { text: errorMessage });
                }
            } else {
                await sock.sendMessage(from, { text: 'Por favor, proporciona un número de identificación válido.' });
            }
        }
    }
});

    sessions[sessionId] = sock;
    sock.ev.on('creds.update', saveCreds);
}

// Endpoint para iniciar una nueva sesión (POST)
app.post('/start-session', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    if (sessions[sessionId]) {
        return res.status(400).send('Esta sesión ya está activa.');
    }

    await createSession(sessionId);
    res.send({ message: 'Sesión iniciada. Escanea el código QR usando el endpoint GET /get-qr/:sessionId.' });
});

// Endpoint para obtener el QR de una sesión (GET)
app.get('/get-qr/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);

    if (fs.existsSync(qrCodePath)) {
        res.sendFile(qrCodePath);
    } else {
        res.status(404).send('QR no encontrado. Asegúrate de iniciar la sesión primero.');
    }
});

// Endpoint para enviar mensajes (POST)
app.post('/send-message', (req, res) => {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
        return res.status(400).send('sessionId, to y message son requeridos.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    session.sendMessage(`${to}@s.whatsapp.net`, { text: message })
        .then(() => res.send('Mensaje enviado correctamente.'))
        .catch(err => res.status(500).send('Error al enviar el mensaje: ' + err.message));
});

// Endpoint para obtener contactos (POST)
app.post('/get-contacts', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    try {
        // Acceder a los contactos desde store.contacts
        const contacts = store.contacts;
        res.json(contacts);
    } catch (err) {
        res.status(500).send('Error al obtener los contactos: ' + err.message);
    }
});



// Endpoint para obtener la lista de grupos (POST)
app.post('/get-groups', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    try {
        const groups = await session.groupFetchAllParticipating();
        res.json(groups);
    } catch (err) {
        res.status(500).send('Error al obtener la lista de grupos: ' + err.message);
    }
});


app.post('/get-all-chats', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    try {
        // Verificar si store.chats está definido y contiene conversaciones
        if (!store.chats || store.chats.all().length === 0) {
            return res.status(404).send('No se encontraron conversaciones.');
        }

        const chats = store.chats.all(); // Obtener todos los chats
        res.json(chats);
    } catch (err) {
        res.status(500).send('Error al obtener las conversaciones: ' + err.message);
    }
});



// Endpoint para obtener la conversación de un número específico (POST)
app.post('/get-chat-by-number', async (req, res) => {
    const { sessionId, phoneNumber } = req.body; // El phoneNumber debe incluir el código de país

    // Validar la entrada
    if (!sessionId || !phoneNumber) {
        return res.status(400).send('El sessionId y el phoneNumber son requeridos.');
    }

    const session = sessions[sessionId]; // Obtener la sesión correspondiente

    // Verificar si la sesión existe
    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    try {
        // Verifica si los chats existen en el store
        if (!store.chats) {
            return res.status(404).send('No se encontraron conversaciones.');
        }

        // Crear el JID del número de WhatsApp
        const jid = `${phoneNumber}@s.whatsapp.net`;

        // Obtener el chat de ese número específico
        const chat = store.chats.get(jid);

        // Verificar si hay un chat para ese número
        if (!chat) {
            return res.status(404).send(`No se encontró una conversación con el número ${phoneNumber}.`);
        }

        // Si se encuentra el chat, devolver la información
        res.json(chat);
    } catch (err) {
        // Manejar errores en caso de que ocurra algo
        res.status(500).send('Error al obtener la conversación: ' + err.message);
    }
});


// Endpoint para verificar el estado de la sesión (POST)
app.post('/check-session', (req, res) => {
    const { sessionId } = req.body;

    // Validar que se proporcione un sessionId
    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    // Buscar la sesión en el objeto 'sessions'
    const session = sessions[sessionId];

    // Comprobar si la sesión existe
    if (!session) {
        return res.status(404).send('Sesión no encontrada.');
    }

    // Devolver el estado actual de la sesión
    res.json({
        sessionId: sessionId,
        status: session.connectionStatus // Devuelve "activa" o "inactiva"
    });
});






// Servir los QR codes generados como imágenes estáticas
app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));

// Iniciar el servidor en el puerto 3000
app.listen(3000, () => {
    console.log('Servidor ejecutándose en el puerto 3000');
});

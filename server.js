const cors = require('cors'); // Importa el paquete cors
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Asegúrate de tener axios instalado
const mime = require('mime-types'); // Para obtener el mime type de forma automática

// Crear el store para almacenar contactos (declararlo globalmente)
const store = makeInMemoryStore({});

// Vincular el almacenamiento del store a un archivo (opcional, si quieres persistir datos entre reinicios)
store.readFromFile('./baileys_store.json');

// Guardar el store periódicamente en el archivo
setInterval(() => {
    store.writeToFile('./baileys_store.json');
}, 10_000);

const app = express();
app.use(cors()); // Habilita CORS para todas las rutas
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
            console.log(`Conexión abierta para la sesión ${sessionId}`);
            sock.connectionStatus = "activa"; // Actualizar estado a activa
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

        if (messageContent.startsWith('guibis ') && sessionId === 'D395771085AAB05244A4FB8FD91BF4EE') {
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
        
                    // Procesar cada mensaje por separado
                    for (const mensaje of mensajes) {
                        // Expresión regular para detectar URLs
                        const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|pdf|mp4|docx|xlsx|zip|xml))/ig;
                        const urlMatches = mensaje.match(urlRegex);
                        const textWithoutUrls = mensaje.replace(urlRegex, '').trim();
        
                        // Enviar el mensaje sin URLs
                        await sock.sendMessage(from, { text: textWithoutUrls });
        
                        // Si hay URLs, procesarlas
                        if (urlMatches && urlMatches.length > 0) {
                            for (const fileUrl of urlMatches) {
                                const fileName = path.basename(fileUrl);
                                const filePath = path.join(__dirname, 'files', fileName);
        
                                // Verificar si el archivo ya existe
                                if (!fs.existsSync(filePath)) {
                                    // Descargar el archivo si no existe
                                    const response = await axios({
                                        url: fileUrl,
                                        method: 'GET',
                                        responseType: 'stream'
                                    });
        
                                    // Guardar el archivo en la carpeta 'files'
                                    const writer = fs.createWriteStream(filePath);
                                    response.data.pipe(writer);
        
                                    await new Promise((resolve, reject) => {
                                        writer.on('finish', resolve);
                                        writer.on('error', reject);
                                    });
        
                                    console.log(`Archivo descargado: ${filePath}`);
                                } else {
                                    console.log(`Archivo ya existe: ${filePath}`);
                                }
        
                                // Leer el archivo descargado y convertirlo en un buffer
                                const fileBuffer = fs.readFileSync(filePath);
        
                                // Detectar el tipo MIME automáticamente según la extensión del archivo
                                const mimeType = mime.lookup(filePath) || 'application/octet-stream'; // Usa 'application/octet-stream' si no se puede detectar el tipo MIME
        
                                // Enviar archivo multimedia usando Baileys
                                await sock.sendMessage(from, {
                                    document: fileBuffer,
                                    mimetype: mimeType,
                                    fileName: fileName,
                                });
                                console.log(`Archivo multimedia enviado: ${filePath}`);
                            }
                        }
                    }
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
app.post('/reset-session-prev', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    if (sessions[sessionId]) {
        return res.status(400).json({
            success: false,
            message: 'Esta sesión ya está activao se ha vuelto a activar.',
            sessionId: sessionId
        });
    }

    await createSession(sessionId);
    res.send({ message: 'Sesión iniciada. Escanea el código QR usando el endpoint GET /get-qr/:sessionId.' });
});



// Ruta para cerrar sesión
app.post('/close-session-full', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({
            success: false,
            message: 'El sessionId es requerido.'
        });
    }

    // Verificar si la sesión existe
    if (!sessions[sessionId]) {
        return res.status(404).json({
            success: false,
            message: 'La sesión no existe.',
            sessionId: sessionId
        });
    }

    try {
        const sock = sessions[sessionId];

        // Cerrar la sesión y eliminar del almacenamiento
        await sock.logout();
        delete sessions[sessionId]; 

         // Eliminar la carpeta de sesión
         const sessionPath = path.join(__dirname, 'sessions', sessionId);
         fs.rmdir(sessionPath, { recursive: true }, (err) => {
             if (err) {
                 console.error(`Error al eliminar la carpeta de la sesión ${sessionId}:`, err);
             } else {
                 console.log(`Carpeta de la sesión ${sessionId} eliminada correctamente.`);
             }
         });
 



        console.log(`Sesión ${sessionId} cerrada correctamente.`);
        return res.json({
            success: true,
            message: `Sesión ${sessionId} cerrada correctamente.`
        });

    } catch (error) {
        console.error(`Error cerrando la sesión ${sessionId}:`, error);
        return res.status(500).json({
            success: false,
            message: `Error al cerrar la sesión ${sessionId}`,
            error: error.message
        });
    }
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

// Endpoint para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
        return res.status(400).send('sessionId, to y message son requeridos.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada.' });
    }

    try {
        // Expresión regular para detectar URLs de archivos multimedia
        const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|pdf|mp4|docx|xlsx|zip|xml))/ig;
        const urlMatches = message.match(urlRegex);
        const textWithoutUrls = message.replace(urlRegex, '').trim();

        if (urlMatches && urlMatches.length > 0) {
            // Procesar cada URL detectada
            for (const fileUrl of urlMatches) {
                const fileName = path.basename(fileUrl);
                const filePath = path.join(__dirname, 'files', fileName);

                // Verificar si el archivo ya existe
                if (!fs.existsSync(filePath)) {
                    // Descargar el archivo
                    const response = await axios({
                        url: fileUrl,
                        method: 'GET',
                        responseType: 'stream'
                    });

                    // Guardar el archivo en la carpeta 'files'
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    console.log(`Archivo descargado: ${filePath}`);
                } else {
                    console.log(`Archivo ya existe: ${filePath}`);
                }

                // Leer el archivo descargado y convertirlo en un buffer
                const fileBuffer = fs.readFileSync(filePath);

                // Detectar el tipo MIME automáticamente según la extensión del archivo
                const mimeType = mime.lookup(filePath) || 'application/octet-stream'; // Usa 'application/octet-stream' si no se puede detectar el tipo MIME

                // Enviar archivo multimedia usando Baileys
                await session.sendMessage(`${to}@s.whatsapp.net`, {
                    document: fileBuffer,
                    mimetype: mimeType,
                    fileName: fileName,
                });
                console.log(`Archivo multimedia enviado: ${filePath}`);
            }
        }

        // Si hay texto sin URLs, enviar como mensaje de texto
        if (textWithoutUrls) {
            await session.sendMessage(`${to}@s.whatsapp.net`, { text: textWithoutUrls });
            console.log('Mensaje de texto enviado correctamente.');
        }

        res.json({ message: 'Mensaje enviado correctamente.' });
    } catch (err) {
        res.status(500).send('Error al enviar el mensaje: ' + err.message);
    }
});




// Endpoint para obtener contactos (POST)
app.post('/get-contacts', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada.' });
    }

    try {
        // Acceder a los contactos desde store.contacts
        const contacts = store.contacts;
        res.json(contacts);
    } catch (err) {
        res.status(500).send('Error al obtener los contactos: ' + err.message);
    }
});



function timeoutPromise(promise, ms) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Tiempo agotado')), ms)
    );
    return Promise.race([promise, timeout]);
}

app.post('/get-groups', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: 'El sessionId es requerido.' });
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada.' });
    }

    try {
        // Limitar la búsqueda de grupos a 8 segundos
        const groups = await timeoutPromise(session.groupFetchAllParticipating(), 8000);

        if (groups && Object.keys(groups).length > 0) {
            res.json(groups); // Si se encuentran grupos, los devuelve
        } else {
            res.status(404).json({ error: 'No se encontraron grupos.' });
        }
    } catch (err) {
        // Manejar el error de tiempo de espera sin mostrarlo en consola
        if (err.message === 'Tiempo agotado') {
            // No mostrar el error en consola, solo enviar una respuesta JSON
            return res.status(408).json({ 
                status: 'error', 
                message: 'Tiempo de espera agotado. No se encontraron grupos en el tiempo permitido.' 
            });
        }

        // Para cualquier otro error, envía un mensaje JSON sin imprimir en consola
        res.status(500).json({ 
            status: 'error', 
            message: 'Error al obtener la lista de grupos.' 
        });
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
        return res.status(404).json({ error: 'Sesión no encontrada.' });
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
        return res.status(404).json({ error: 'Sesión no encontrada.' });
    }

    // Devolver el estado actual de la sesión
    res.json({
        sessionId: sessionId,
        status: session.connectionStatus // Devuelve "activa" o "inactiva"
    });
});



app.post('/close-session-prev', (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada.' });
    }

    // Cerrar la conexión y eliminar la sesión
    session.end(true); // Terminar la sesión
    delete sessions[sessionId]; // Eliminar la sesión del objeto de sesiones

    // Eliminar el archivo QR si existe
    const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);
    if (fs.existsSync(qrCodePath)) {
        fs.unlinkSync(qrCodePath);
        console.log(`Archivo QR ${qrCodePath} eliminado.`);
    }

    // Eliminar los archivos de credenciales si existen
    const sessionDir = path.join(__dirname, 'sessions', sessionId);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`Archivos de sesión para ${sessionId} eliminados.`);
    }

    res.send({ message: `Sesión ${sessionId} cerrada y eliminada correctamente.` });
});


app.post('/start-session', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'Falta el sessionId.' });
    }

    if (sessions[sessionId]) {
        return res.status(400).json({
            success: false,
            message: `La sesión con ID ${sessionId} ya está activa.`,
        });
    }

    try {
        await createSession(sessionId);
        res.status(200).json({ success: true, message: `Sesión ${sessionId} iniciada correctamente.` });
    } catch (error) {
        console.error('Error al crear la sesión:', error);
        res.status(500).json({ success: false, message: 'Error al iniciar la sesión.' });
    }
});


// Cargar sesiones existentes al iniciar el servidor
async function loadExistingSessions() {
    const sessionsDir = './sessions';
    const sessionDirs = fs.readdirSync(sessionsDir).filter(file => fs.statSync(path.join(sessionsDir, file)).isDirectory());

    for (const sessionId of sessionDirs) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                // Intentar crear la sesión y almacenar el socket en el objeto sessions
                await createSession(sessionId);
                console.log(`Sesión ${sessionId} cargada correctamente.`);

                // Actualizar estado a activa en el objeto sessions
                sessions[sessionId].connectionStatus = "activa"; 
                break; // Salir del bucle si la sesión se carga correctamente
            } catch (error) {
                attempts++;
                console.error(`Error al cargar la sesión ${sessionId}. Intento ${attempts} de ${maxAttempts}.`, error);

                // Si se alcanzó el número máximo de intentos
                if (attempts === maxAttempts) {
                    console.error(`No se pudo cargar la sesión ${sessionId} después de ${maxAttempts} intentos. Pasando a la siguiente.`);
                    
                    // Actualizar estado a inactiva en el objeto sessions
                    if (sessions[sessionId]) {
                        sessions[sessionId].connectionStatus = "inactiva"; 
                    }
                }
            }
        }
    }
}




// Servir los QR codes generados como imágenes estáticas
app.use('/qrcodes', express.static(path.join(__dirname, 'qrcodes')));

app.listen(3000, '0.0.0.0', () => {
    console.log('Servidor ejecutándose en el puerto 3000');
    loadExistingSessions(); // Cargar sesiones existentes (sin await)
    console.log('Iniciando carga de sesiones existentes...');
});



const cors = require('cors'); // Importa el paquete cors
const express = require('express');
const PORT = process.env.PORT || 3000; // Cambiar 3000 a la variable de entorno
const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Asegúrate de tener axios instalado
const mime = require('mime-types'); // Para obtener el mime type de forma automática
const { promisify } = require('util'); // Importar promisify
const stream = require('stream');

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

       sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const from = msg.key.remoteJid; // JID del remitente
            const messageContent = msg.message.conversation || msg.message?.text || '';
            
            // Imprimir la información deseada
            console.log(`Mensaje recibido de: ${from}`);
            console.log(`Contenido del mensaje: ${messageContent}`);
            console.log(`Session ID: ${sessionId}`);

            try {
                const response = await axios.post('http://localhost/dev/wspguibis/system_gtp', {
                    sessionId: sessionId,
                    from: from,
                    messageContent: messageContent,
                    user: "usuario" // Asegúrate de definir el usuario correspondiente
                });
    
                // Manejar la respuesta de la API
                console.log('Respuesta de la API:', response.data);
            } catch (error) {
                console.error('Error al enviar los datos a la API:', error);
            }


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

            if (messageContent.startsWith('Comprar en ')) {
                // Extraer la parte de "Comprar en"
                const empresa = messageContent.split('Comprar en ')[1]?.trim();
                console.log('Empresa extraída:', empresa);
            
                // Comprobar si se proporcionó una empresa
                if (empresa) {
                    try {
                        // Llamar a la API para buscar la empresa
                        const response = await axios.post('https://guibis.com/dev/wspguibis/searchempresa', {
                            search_empresa: empresa
                        });
            
                        console.log('Respuesta de la API buscar empresa:', response.data); // Log de la respuesta de la API
            
                        const data = response.data;
            
                        // Comprobar si la respuesta contiene la información esperada
                        if (data && data.key) {
                            const { key, nombres } = data;
                            console.log('Clave de la empresa:', key);
                            console.log('Nombres de la empresa:', nombres);
            
                            // Verificar si existe la sesión
                            const sessionExists = await checkSession(key); // Usar la función actualizada para verificar si la sesión existe
                            console.log('Estado de la sesión:', sessionExists);
            
                            if (sessionExists.valid) {
                                // Informar al usuario sobre la empresa solo si la sesión está activa
                                await sock.sendMessage(from, {
                                    text: `Hola Bienvenido a ${nombres}, estamos buscando los productos disponibles...`
                                });
            
                                // Llamar a la API para buscar productos
                                const productosResponse = await axios.get('https://guibis.com/dev/wspguibis/searchproductos', {
                                    headers: { 'Authorization': `Bearer ${key}` } // Utiliza la key como token de sesión
                                });
            
                                console.log('Respuesta de la API buscar productos:', productosResponse.data); // Log de la respuesta de la API
            
                                const productosData = productosResponse.data;
            
                                // Enviar cada producto en un mensaje separado
                                if (productosData && productosData.productos) {
                                    for (const producto of productosData.productos) {
                                        console.log('Producto encontrado:', producto); // Log de cada producto
                                        await sock.sendMessage(from, { text: producto });
                                    }
                                } else {
                                    await sock.sendMessage(from, { text: 'No se encontraron productos disponibles.' });
                                }
                            } else {
                                console.log(`No hay sesión activa para la clave ${key}. No se enviará ningún mensaje.`);
                              
                            }
                        } else {
                           // await sock.sendMessage(from, { text: 'No se encontró información para la empresa. Inténtalo más tarde.' });
                        }
                    } catch (error) {
                        console.error('Error al consumir la API:', error);
                        const errorMessage = error.response?.data?.mensaje || 'Error al consultar la API. Inténtalo más tarde.';
                        //await sock.sendMessage(from, { text: errorMessage });
                    }
                } else {
                  
                }
            }






        }
    });

    sessions[sessionId] = sock;
    sock.ev.on('creds.update', saveCreds);
}

async function checkSession(key) {
    // Comprobar si la clave de sesión existe en el objeto sessions
    const session = Object.values(sessions).find(sock => sock.authState.keys[key]);

    if (session) {
        return { valid: true }; // Si la sesión existe, devuelve que es válida
    } else {
        return { valid: false }; // Si no existe, devuelve que no es válida
    }
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
// Endpoint para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { sessionId, to, message } = req.body;

    if (!sessionId || !to || !message) {
        return res.status(400).json({
            error: true,
            message: 'sessionId, to y message son requeridos.'
        });
    }

    // Buscar la sesión en el objeto 'sessions'
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía
        if (filesInSessionDir.length === 0) {
            return res.status(400).json({ error: 'La sesión no ha sido completada (no se ha escaneado el QR).' });
        }

        // Expresión regular para detectar URLs de archivos multimedia
        const urlRegex = /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|pdf|mp4|docx|xlsx|zip|xml))/ig;
        const urlMatches = message.match(urlRegex);
        const textWithoutUrls = message.replace(urlRegex, '').trim();

        let textUsedAsCaption = false;  // Indicador para saber si el texto ya se usó como leyenda

        // Procesar archivos multimedia
        if (urlMatches && urlMatches.length > 0) {
            for (let i = 0; i < urlMatches.length; i++) {
                const fileUrl = urlMatches[i];
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
                const mimeType = mime.lookup(filePath) || 'application/octet-stream';

                if (mimeType.startsWith('image/')) {
                    // Enviar imagen
                    await session.sendMessage(`${to}@s.whatsapp.net`, {
                        image: fileBuffer,
                        caption: !textUsedAsCaption && textWithoutUrls ? textWithoutUrls : null // Agregar leyenda solo en la primera imagen
                    });
                    textUsedAsCaption = true; // Marcar que el texto ya se usó
                    console.log(`Imagen enviada: ${filePath}`);
                } else if (mimeType.startsWith('video/')) {
                    // Enviar video
                    await session.sendMessage(`${to}@s.whatsapp.net`, {
                        video: fileBuffer,
                        caption: !textUsedAsCaption && textWithoutUrls ? textWithoutUrls : null // Agregar leyenda solo en el primer video
                    });
                    textUsedAsCaption = true; // Marcar que el texto ya se usó
                    console.log(`Video enviado: ${filePath}`);
                } else {
                    // Enviar como documento para otros tipos de archivos
                    await session.sendMessage(`${to}@s.whatsapp.net`, {
                        document: fileBuffer,
                        mimetype: mimeType,
                        fileName: fileName,
                    });
                    console.log(`Archivo multimedia enviado: ${filePath}`);
                }
            }
        }

        // Enviar texto si no se usó como leyenda y hay mensaje sin URLs
        if (!textUsedAsCaption && textWithoutUrls) {
            await session.sendMessage(`${to}@s.whatsapp.net`, { text: textWithoutUrls });
            console.log('Mensaje de texto enviado correctamente.');
        }

        res.json({ message: 'Mensaje enviado correctamente.' });
    } catch (err) {
        res.status(500).json({
            error: true,
            message: 'Error al enviar el mensaje: ' + err.message
        });
    }
});


// Endpoint para obtener contactos (POST)
app.post('/get-contacts', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    const session = sessions[sessionId];

    // Verificar si la sesión existe en la memoria
    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía
        if (filesInSessionDir.length === 0) {
            return res.status(400).json({ error: 'La sesión no ha sido completada (no se ha escaneado el QR).' });
        }

        // Si la carpeta no está vacía, se asume que la sesión está completa
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



// Endpoint para obtener grupos
app.post('/get-groups', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: 'El sessionId es requerido.' });
    }

    // Buscar la sesión en el objeto 'sessions'
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía
        if (filesInSessionDir.length === 0) {
            return res.status(400).json({ error: 'La sesión no ha sido completada (no se ha escaneado el QR).' });
        }

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




// Endpoint para obtener todas las conversaciones (chats)
app.post('/get-all-chats', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).send('El sessionId es requerido.');
    }

    // Buscar la sesión en el objeto 'sessions'
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía
        if (filesInSessionDir.length === 0) {
            return res.status(400).json({ error: 'La sesión no ha sido completada (no se ha escaneado el QR).' });
        }

        // Verificar si 'store.chats' está definido y contiene conversaciones
        if (!store.chats || store.chats.all().length === 0) {
            return res.status(404).send('No se encontraron conversaciones.');
        }

        const chats = store.chats.all(); // Obtener todos los chats
        res.json(chats);
    } catch (err) {
        res.status(500).send('Error al obtener las conversaciones: ' + err.message);
    }
});




// Endpoint para obtener la conversación de un número específico
app.post('/get-chat-by-number', async (req, res) => {
    const { sessionId, phoneNumber } = req.body; // El phoneNumber debe incluir el código de país

    // Validar la entrada
    if (!sessionId || !phoneNumber) {
        return res.status(400).send('El sessionId y el phoneNumber son requeridos.');
    }

    const session = sessions[sessionId]; // Obtener la sesión correspondiente

    // Verificar si la sesión existe en memoria
    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía (sesión incompleta)
        if (filesInSessionDir.length === 0) {
            return res.status(400).json({ error: 'La sesión no ha sido completada (no se ha escaneado el QR).' });
        }

        // Verificar si los chats existen en el store
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
        return res.status(500).json({ error: 'Error al obtener la conversación: ' + err.message });

    }
});

// Endpoint para verificar el estado de la sesión (POST)
app.post('/check-session', (req, res) => {
    const { sessionId } = req.body;

    // Validar que se proporcione un sessionId
    if (!sessionId) {
        return res.status(400).json({ error: 'El sessionId es requerido.' });

    }

    // Buscar la sesión en el objeto 'sessions'
    const session = sessions[sessionId];

    // Comprobar si la sesión existe en memoria
    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada en la memoria.' });
    }

    try {
        // Ruta de la carpeta de la sesión
        const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

        // Verificar si la carpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            return res.status(404).json({ error: 'Sesión no encontrada en la carpeta de sesiones.' });
        }

        // Leer el contenido de la carpeta
        const filesInSessionDir = fs.readdirSync(sessionDirPath);

        // Verificar si la carpeta está vacía
        if (filesInSessionDir.length === 0) {
            return res.status(200).json({
                sessionId: sessionId,
                status: 'inactiva', // La sesión no ha sido completada (QR no escaneado)
                message: 'La sesión no ha sido completada (no se ha escaneado el QR).'
            });
        }

        // Si la carpeta no está vacía, la sesión se considera completada
        res.status(200).json({
            sessionId: sessionId,
            status: 'activa', // Sesión completada
            message: 'La sesión está completa.'
        });

    } catch (err) {
        res.status(500).send('Error al verificar la sesión: ' + err.message);
    }
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




app.post('/close-all-sessions', (req, res) => {
    // Recorrer cada sesión activa en el objeto 'sessions'
    for (const sessionId in sessions) {
        const session = sessions[sessionId];

        // Finalizar la sesión si existe
        if (session) {
            session.end(true);
            console.log(`Sesión ${sessionId} cerrada.`);
        }

        // Eliminar la sesión del objeto 'sessions'
        delete sessions[sessionId];

        // Eliminar el archivo QR correspondiente
        const qrCodePath = path.join(__dirname, 'qrcodes', `${sessionId}.png`);
        if (fs.existsSync(qrCodePath)) {
            fs.unlinkSync(qrCodePath);
            console.log(`Archivo QR ${qrCodePath} eliminado.`);
        }
    }

    // Eliminar todas las carpetas en la carpeta 'sessions'
    const sessionsDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        fs.readdirSync(sessionsDir).forEach((file) => {
            const filePath = path.join(sessionsDir, file);
            if (fs.lstatSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
                console.log(`Directorio de sesión ${filePath} eliminado.`);
            }
        });
    }

    res.send({ message: 'Todas las sesiones cerradas y archivos eliminados correctamente.' });
});

// Endpoint para iniciar una sesión
app.post('/start-session', async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json({ success: false, message: 'Falta el sessionId.' });
    }

    // Ruta de la carpeta de la sesión
    const sessionDirPath = path.join(__dirname, 'sessions', sessionId);

    // Verificar si la sesión ya está activa en memoria
    if (sessions[sessionId]) {
        return res.status(400).json({
            success: false,
            message: `La sesión con ID ${sessionId} ya está activa.`,
        });
    }

    // Verificar si la carpeta de la sesión ya existe y no está vacía
    if (fs.existsSync(sessionDirPath) && fs.readdirSync(sessionDirPath).length > 0) {
        return res.status(400).json({
            success: false,
            message: `La sesión con ID ${sessionId} ya ha sido iniciada previamente. Por favor, cierra la sesión actual antes de reiniciarla.`,
        });
    }

    // Iniciar una nueva sesión si no está activa y la carpeta no contiene datos
    try {
        await createSession(sessionId);
        res.status(200).json({ success: true, message: `Sesión ${sessionId} iniciada correctamente.` });
    } catch (error) {
        console.error('Error al crear la sesión:', error);
        res.status(500).json({ success: false, message: 'Error al iniciar la sesión.' });
    }
});


app.post('/download-file', async (req, res) => {
    const { fileUrl } = req.body;

    if (!fileUrl) {
        console.log('Falta la URL del archivo en la solicitud.');
        return res.status(400).json({ success: false, message: 'Falta la URL del archivo.' });
    }

    try {
        console.log(`Intentando descargar el archivo desde: ${fileUrl}`);
        const fileName = path.basename(fileUrl); // Obtener nombre del archivo
        const filePath = path.join(__dirname, 'files', fileName); // Ruta de destino

        console.log(`Ruta de destino: ${filePath}`);
        const writer = fs.createWriteStream(filePath); // Crear stream de escritura

        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        console.log('Respuesta recibida, empezando a guardar el archivo.');
        response.data.pipe(writer); // Descargar el archivo

        const finished = promisify(stream.finished); // Promesa para esperar hasta que el stream termine
        await finished(writer);

        console.log('Archivo descargado y guardado con éxito.');
        return res.status(200).json({ success: true, message: 'Archivo descargado con éxito.', fileName });
    } catch (error) {
        console.error('Error al descargar el archivo:', error.message);
        console.log('Detalles del error:', error); // Muestra detalles del error
        return res.status(500).json({ success: false, message: 'Error al descargar el archivo.' });
    }
});


// Endpoint para verificar la existencia de un archivo y obtener su tamaño
app.post('/check-file', (req, res) => {
    const { fileName } = req.body;

    if (!fileName) {
        return res.status(400).json({ success: false, message: 'Falta el nombre del archivo.' });
    }

    const filePath = path.join(__dirname, 'files', fileName);

    // Verificar si el archivo existe y obtener su información
    fs.stat(filePath, (err, stats) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // El archivo no existe
                return res.status(404).json({ success: false, message: 'El archivo no existe.' });
            } else {
                // Otro error
                console.error('Error al obtener información del archivo:', err);
                return res.status(500).json({ success: false, message: 'Error al verificar el archivo.' });
            }
        }

        // Archivo existe, enviar información
        return res.status(200).json({
            success: true,
            message: 'El archivo existe.',
            fileName,
            size: stats.size, // Tamaño del archivo en bytes
            createdAt: stats.birthtime, // Fecha de creación
            modifiedAt: stats.mtime // Fecha de última modificación
        });
    });
});


// Endpoint para eliminar todas las carpetas y archivos en 'files'
app.post('/clear-files', (req, res) => {
    const dirPath = path.join(__dirname, 'files');

    // Verificar si la carpeta 'files' existe
    if (!fs.existsSync(dirPath)) {
        return res.status(404).json({ success: false, message: 'La carpeta "files" no existe.' });
    }

    // Función para eliminar recursivamente el contenido de la carpeta
    const deleteFolderContents = (folderPath) => {
        // Obtener todos los elementos dentro de la carpeta
        const files = fs.readdirSync(folderPath);
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stat = fs.statSync(filePath);

            // Si es un directorio, llamar recursivamente
            if (stat.isDirectory()) {
                deleteFolderContents(filePath);
                fs.rmdirSync(filePath); // Eliminar el directorio una vez vaciado
            } else {
                fs.unlinkSync(filePath); // Eliminar el archivo
            }
        }
    };

    try {
        deleteFolderContents(dirPath); // Eliminar el contenido de 'files'
        return res.status(200).json({ success: true, message: 'Todos los archivos y carpetas han sido eliminados de "files".' });
    } catch (error) {
        console.error('Error al eliminar el contenido de la carpeta "files":', error);
        return res.status(500).json({ success: false, message: 'Error al limpiar la carpeta "files".' });
    }
});


// Endpoint para eliminar un archivo
app.post('/delete-file', (req, res) => {
    const { fileName } = req.body;

    if (!fileName) {
        return res.status(400).json({ success: false, message: 'Falta el nombre del archivo.' });
    }

    const filePath = path.join(__dirname, 'files', fileName);

    fs.unlink(filePath, (err) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // El archivo no existe
                return res.status(404).json({ success: false, message: 'El archivo no existe.' });
            } else {
                // Error al intentar eliminar el archivo
                console.error('Error al eliminar el archivo:', err);
                return res.status(500).json({ success: false, message: 'Error al eliminar el archivo.' });
            }
        }

        // Archivo eliminado con éxito
        return res.status(200).json({ success: true, message: 'Archivo eliminado con éxito.' });
    });
});


// Cargar sesiones existentes al iniciar el servidor
async function loadExistingSessions() {
    const sessionsDir = './sessions';

    // Verificar si la carpeta 'sessions' existe, si no, crearla
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        console.log(`La carpeta "${sessionsDir}" ha sido creada.`);
        return; // Salir si se creó la carpeta, ya que no hay sesiones que cargar
    }

    // Leer directorios dentro de 'sessions'
    const sessionDirs = fs.readdirSync(sessionsDir).filter(file => fs.statSync(path.join(sessionsDir, file)).isDirectory());

    for (const sessionId of sessionDirs) {
        const sessionDirPath = path.join(sessionsDir, sessionId);
        let attempts = 0;
        const maxAttempts = 3;

        // Verificar si la subcarpeta de la sesión existe
        if (!fs.existsSync(sessionDirPath)) {
            console.warn(`La carpeta de sesión "${sessionDirPath}" no existe. Omitiendo la carga de esta sesión.`);
            continue; // Omitir esta sesión si no existe
        }

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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);
    loadExistingSessions(); // Cargar sesiones existentes (sin await)
    console.log('Iniciando carga de sesiones existentes...');
});


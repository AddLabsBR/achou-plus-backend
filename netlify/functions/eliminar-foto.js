/**
 * POST /.netlify/functions/eliminar-foto
 * Cabeçalho: Authorization: Bearer <ID token do Firebase Auth>
 * Body: { empresaId, anuncioId }
 *
 * Apaga no Cloudinary as fotos do anúncio indicado. É chamado ANTES do
 * documento do anúncio ser apagado do Firestore, porque busca a lista de
 * fotos direto do próprio documento (nunca confia em URLs que o navegador
 * mande) — assim ninguém consegue usar este endpoint pra apagar fotos de
 * um anúncio que não seja o seu.
 *
 * Precisa de 3 variáveis de ambiente novas no Netlify (Site settings →
 * Environment variables), tiradas do Dashboard do Cloudinary:
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET  (fica só aqui no servidor — nunca no navegador)
 */

const admin = require('firebase-admin');
const https = require('https');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Tira o public_id de uma URL do Cloudinary, ex.:
// https://res.cloudinary.com/zzhznqvi/image/upload/v1234567890/zoons/anuncios/abc123.jpg
// -> zoons/anuncios/abc123
function extrairPublicId(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-zA-Z0-9]+(?:\?.*)?$/);
    return m ? m[1] : null;
}

function deletarNoCloudinary(publicIds) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ public_ids: publicIds });
        const auth = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
        const req = https.request({
            hostname: 'api.cloudinary.com',
            path: `/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image/upload`,
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': `Basic ${auth}`
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject(new Error(`Cloudinary respondeu ${res.statusCode}: ${data}`));
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Método não permitido' }) };
    }

    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não autenticado.' }) };
    }

    let uid;
    try {
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        uid = decoded.uid;
    } catch (err) {
        return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Sessão inválida. Faça login novamente.' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (err) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Corpo inválido.' }) };
    }
    const { empresaId, anuncioId } = payload;
    if (!empresaId || !anuncioId) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Faltam empresaId/anuncioId.' }) };
    }

    // Só o dono da empresa pode apagar as fotos dos anúncios dela
    const empresaRef = db.collection('empresas').doc(empresaId);
    const empresaSnap = await empresaRef.get();
    if (!empresaSnap.exists || empresaSnap.data().uid !== uid) {
        return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Você não tem permissão sobre este anúncio.' }) };
    }

    const anuncioRef = empresaRef.collection('anuncios').doc(anuncioId);
    const anuncioSnap = await anuncioRef.get();
    if (!anuncioSnap.exists) {
        // Já foi apagado (ou nunca existiu) — não é erro, só não tem o que fazer
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, apagadas: 0 }) };
    }

    const fotos = Array.isArray(anuncioSnap.data().fotos) ? anuncioSnap.data().fotos : [];
    const publicIds = fotos.map(extrairPublicId).filter(Boolean);

    if (!publicIds.length) {
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, apagadas: 0 }) };
    }
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Cloudinary não configurado no servidor (faltam variáveis de ambiente).' }) };
    }

    try {
        await deletarNoCloudinary(publicIds);
    } catch (err) {
        console.error('Erro ao apagar fotos no Cloudinary:', err);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível apagar as fotos no Cloudinary.' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, apagadas: publicIds.length }) };
};

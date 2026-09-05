/**
 * POST /.netlify/functions/recalcular-avaliacoes
 * Body: { "empresaId": "..." }
 *
 * Chamada pelo site logo depois que alguém envia uma avaliação.
 * Recalcula a média e o total de avaliações da empresa e grava no Firestore
 * (o dono da empresa não pode escrever nesses campos diretamente — só este
 * backend ou o admin, conforme as regras do Firestore).
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Método não permitido' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

    const empresaId = body.empresaId;
    if (!empresaId) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'empresaId é obrigatório' }) };
    }

    const snap = await db.collection('avaliacoes').where('empresaId', '==', empresaId).get();
    const total = snap.size;
    const soma = snap.docs.reduce((acc, doc) => acc + (doc.data().nota || 0), 0);
    const media = total > 0 ? soma / total : 0;

    await db.collection('empresas').doc(empresaId).update({
        avaliacao_media: media,
        total_avaliacoes: total
    });

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ media, total }) };
};

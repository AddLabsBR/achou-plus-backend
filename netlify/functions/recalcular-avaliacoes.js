/**
 * POST /.netlify/functions/recalcular-avaliacoes
 * Cabeçalho: Authorization: Bearer <ID token do Firebase Auth>
 * Body: { "empresaId": "..." }
 *
 * Chamada pelo site logo depois que alguém envia uma avaliação.
 * Recalcula a média e o total de avaliações da empresa e grava no Firestore
 * (o dono da empresa não pode escrever nesses campos diretamente — só este
 * backend ou o admin, conforme as regras do Firestore).
 *
 * Antes esta função não pedia login nenhum — qualquer um na internet podia
 * chamar ela repetidamente pra qualquer empresaId, gastando leituras e
 * escritas do Firestore à toa (não dava pra forjar uma nota falsa, porque
 * ela sempre recalcula a partir das avaliações reais, mas ainda assim é
 * uma porta aberta sem necessidade). Agora exige estar logado.
 */

const admin = require('firebase-admin');
const { corsHeaders } = require('./_cors');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

exports.handler = async (event) => {
    const CORS_HEADERS = corsHeaders(event);

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
    try {
        await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    } catch (err) {
        return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Sessão inválida. Faça login novamente.' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

    const empresaId = body.empresaId;
    if (!empresaId || typeof empresaId !== 'string') {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'empresaId é obrigatório' }) };
    }

    const empresaRef = db.collection('empresas').doc(empresaId);
    const empresaSnap = await empresaRef.get();
    if (!empresaSnap.exists) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Empresa não encontrada.' }) };
    }

    const snap = await db.collection('avaliacoes').where('empresaId', '==', empresaId).get();
    const total = snap.size;
    const soma = snap.docs.reduce((acc, doc) => acc + (doc.data().nota || 0), 0);
    const media = total > 0 ? soma / total : 0;

    await empresaRef.update({
        avaliacao_media: media,
        total_avaliacoes: total
    });

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ media, total }) };
};

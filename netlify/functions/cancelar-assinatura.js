/**
 * POST /.netlify/functions/cancelar-assinatura
 * Cabeçalho: Authorization: Bearer <ID token do Firebase Auth, de uma conta admin>
 * Body: { empresaId }
 *
 * Cancela de verdade a assinatura recorrente da empresa no Mercado Pago
 * (PreApproval) e atualiza o Firestore para refletir isso. Só pode ser
 * chamada por uma conta com usuarios/{uid}.tipo === 'admin' — é a função
 * usada pelo botão "Cancelar assinatura" do painel admin.
 *
 * Precisa da variável de ambiente MP_ACCESS_TOKEN já configurada no
 * Netlify (a mesma usada em criar-assinatura.js) e de FIREBASE_SERVICE_ACCOUNT.
 */

const admin = require('firebase-admin');
const https = require('https');
const { corsHeaders } = require('./_cors');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

function cancelarPreApproval(preapprovalId) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ status: 'cancelled' });
        const req = https.request({
            hostname: 'api.mercadopago.com',
            path: `/preapproval/${preapprovalId}`,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': `Bearer ${MP_ACCESS_TOKEN}`
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                // 404 = o Mercado Pago já não tem mais essa assinatura (já estava
                // cancelada/expirada por lá) — tratamos como sucesso, só sincroniza o Firestore.
                if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 404) {
                    resolve({ statusCode: res.statusCode, data });
                } else {
                    reject(new Error(`Mercado Pago respondeu ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

exports.handler = async (event) => {
    const CORS_HEADERS = corsHeaders(event);
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Método não permitido' }) };
    }
    if (!MP_ACCESS_TOKEN) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Mercado Pago não configurado no servidor (falta MP_ACCESS_TOKEN).' }) };
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

    // Só admin pode cancelar assinatura de outra empresa
    try {
        const usuarioSnap = await db.collection('usuarios').doc(uid).get();
        if (!usuarioSnap.exists || usuarioSnap.data().tipo !== 'admin') {
            return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Apenas administradores podem cancelar assinaturas.' }) };
        }
    } catch (err) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível verificar permissões.' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (err) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Corpo inválido.' }) };
    }
    const { empresaId } = payload;
    if (!empresaId) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Falta empresaId.' }) };
    }

    const empresaRef = db.collection('empresas').doc(empresaId);
    const empresaSnap = await empresaRef.get();
    if (!empresaSnap.exists) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Empresa não encontrada.' }) };
    }

    const empresa = empresaSnap.data();
    if (!empresa.assinatura_id) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Essa empresa não tem uma assinatura para cancelar.' }) };
    }

    try {
        await cancelarPreApproval(empresa.assinatura_id);
    } catch (err) {
        console.error('Erro ao cancelar no Mercado Pago:', err);
        return { statusCode: 502, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível cancelar no Mercado Pago. Tente novamente em instantes.' }) };
    }

    try {
        await empresaRef.update({
            assinatura_status: 'cancelada',
            destaque: false,
            atraso_manual: false,
            cancelada_em: admin.firestore.FieldValue.serverTimestamp(),
            cancelada_por: uid
        });
    } catch (err) {
        console.error('Cancelado no Mercado Pago mas falhou ao atualizar o Firestore:', err);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Cancelado no Mercado Pago, mas houve um erro ao atualizar os dados da empresa. Verifique manualmente.' }) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true }) };
};

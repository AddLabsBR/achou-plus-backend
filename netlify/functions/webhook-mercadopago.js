/**
 * POST /.netlify/functions/webhook-mercadopago
 * Chamada pelo próprio Mercado Pago quando o status de uma assinatura muda
 * (autorizada, pausada, cancelada). Cadastre esta URL no painel do
 * Mercado Pago em: Suas integrações → Webhooks → evento "preapproval".
 */

const admin = require('firebase-admin');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

exports.handler = async (event) => {
    try {
        const params = event.queryStringParameters || {};
        let body = {};
        try { body = JSON.parse(event.body || '{}'); } catch (e) { /* corpo vazio ou não-JSON */ }

        const tipo = params.type || body.type;
        const id = params['data.id'] || (body.data && body.data.id) || params.id;

        if (tipo !== 'preapproval' || !id) {
            return { statusCode: 200, body: 'ok' }; // evento que não nos interessa
        }

        const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
        const preapproval = new PreApproval(client);
        const info = await preapproval.get({ id });

        const empresaId = info.external_reference;
        if (!empresaId) {
            return { statusCode: 200, body: 'ok' };
        }

        const statusMap = {
            authorized: 'ativa',
            paused: 'pausada',
            cancelled: 'cancelada',
            pending: 'pendente'
        };
        const novoStatus = statusMap[info.status] || 'pendente';

        await db.collection('empresas').doc(empresaId).update({
            assinatura_status: novoStatus,
            destaque: novoStatus === 'ativa'
        });

        return { statusCode: 200, body: 'ok' };

    } catch (err) {
        console.error('Erro no webhook do Mercado Pago:', err);
        return { statusCode: 500, body: 'erro' }; // Mercado Pago tenta reenviar
    }
};

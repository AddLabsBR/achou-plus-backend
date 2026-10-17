/**
 * POST /.netlify/functions/webhook-mercadopago
 * Chamada pelo próprio Mercado Pago quando o status de uma assinatura muda
 * (autorizada, pausada, cancelada). Cadastre esta URL no painel do
 * Mercado Pago em: Suas integrações → Webhooks → evento "preapproval".
 *
 * Validação de assinatura (x-signature): o Mercado Pago assina cada
 * notificação com uma chave secreta própria do webhook, pra provar que a
 * chamada realmente veio dele e não de alguém tentando forjar uma. Pra
 * ativar essa checagem, pegue a "Chave secreta" em Suas integrações →
 * Webhooks → (sua notificação) no painel do Mercado Pago, e cadastre no
 * Netlify (Site settings → Environment variables, no site
 * achou-plus-backend) como:
 *   MP_WEBHOOK_SECRET
 * Enquanto essa variável não existir, a função continua funcionando
 * normalmente (só avisa no log que a validação está desligada) — assim
 * o deploy desse arquivo não quebra nada antes de você configurar a chave.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

function cabecalho(headers, nome){
    if (!headers) return null;
    return headers[nome] || headers[nome.toLowerCase()] || headers[nome.toUpperCase()] || null;
}

// Confere se a notificação realmente veio do Mercado Pago, comparando o
// hash que ele manda no cabeçalho x-signature com um hash calculado aqui
// usando a chave secreta do webhook. Veja a explicação completa no
// comentário do topo do arquivo.
function assinaturaValida(event, dataId){
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) {
        console.warn('MP_WEBHOOK_SECRET não configurado — validação de assinatura do webhook está DESLIGADA. Configure essa variável no Netlify para ativar.');
        return true;
    }

    const xSignature = cabecalho(event.headers, 'x-signature');
    const xRequestId = cabecalho(event.headers, 'x-request-id');
    if (!xSignature || !xRequestId) {
        console.error('Notificação sem x-signature/x-request-id — rejeitada.');
        return false;
    }

    const partes = {};
    xSignature.split(',').forEach(pedaco => {
        const [k, v] = pedaco.split('=');
        if (k && v) partes[k.trim()] = v.trim();
    });
    const ts = partes.ts;
    const v1 = partes.v1;
    if (!ts || !v1) {
        console.error('x-signature em formato inesperado — rejeitada.');
        return false;
    }

    // O Mercado Pago pede pra usar o data.id em minúsculas no manifesto,
    // porque às vezes ele chega com letras maiúsculas misturadas.
    const dataIdLower = String(dataId || '').toLowerCase();
    const manifest = `id:${dataIdLower};request-id:${xRequestId};ts:${ts};`;
    const hashCalculado = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    try {
        const a = Buffer.from(hashCalculado, 'hex');
        const b = Buffer.from(v1, 'hex');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (err) {
        console.error('Erro ao comparar assinatura:', err);
        return false;
    }
}

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

        if (!assinaturaValida(event, id)) {
            return { statusCode: 401, body: 'assinatura inválida' };
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

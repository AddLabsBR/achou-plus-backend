/**
 * POST /.netlify/functions/suporte
 * Body: { empresa, problema, whatsapp, site }   (site = campo "isca" anti-robô; deve vir vazio)
 *
 * Recebe o pedido de ajuda do formulário "Suporte" do site e manda a
 * mensagem completa para o Telegram do dono, usando um bot.
 *
 * Variáveis de ambiente novas no Netlify (Site settings → Environment variables):
 *   TELEGRAM_BOT_TOKEN   token que o @BotFather entrega ao criar o bot
 *   TELEGRAM_CHAT_ID     número do seu chat com o bot (veja o passo a passo)
 * O token fica só aqui no servidor — nunca vai para o navegador.
 */

const https = require('https');
const { corsHeaders } = require('./_cors');

// Limite simples por IP (vale por instância da função; já barra spam básico)
const TENTATIVAS = new Map();
const MAX_POR_HORA = 5;

function limitado(ip) {
    const agora = Date.now();
    const lista = (TENTATIVAS.get(ip) || []).filter(t => agora - t < 3600000);
    if (lista.length >= MAX_POR_HORA) { TENTATIVAS.set(ip, lista); return true; }
    lista.push(agora);
    TENTATIVAS.set(ip, lista);
    return false;
}

function limpar(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function enviarTelegram(texto) {
    return new Promise((resolve, reject) => {
        const corpo = JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: texto,
            disable_web_page_preview: true
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) }
        }, res => {
            let dados = '';
            res.on('data', c => dados += c);
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300) ? resolve() : reject(new Error('Telegram ' + res.statusCode + ' ' + dados)));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
        req.write(corpo);
        req.end();
    });
}

exports.handler = async (event) => {
    const cors = corsHeaders(event, 'POST, OPTIONS');
    const resp = (status, obj) => ({ statusCode: status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return resp(405, { erro: 'Método não permitido.' });
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return resp(500, { erro: 'Suporte não configurado.' });

    let b;
    try { b = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { erro: 'Requisição inválida.' }); }

    // Campo isca: robôs preenchem, pessoas não. Finge sucesso e descarta.
    if (b.site) return resp(200, { ok: true });

    const empresa = limpar(b.empresa, 100);
    const problema = limpar(b.problema, 1000);
    const whatsapp = limpar(b.whatsapp, 30);
    const digitos = whatsapp.replace(/\D/g, '');
    if (!empresa || !problema || digitos.length < 10 || digitos.length > 13) {
        return resp(400, { erro: 'Preencha empresa, problema e um WhatsApp válido (com DDD).' });
    }

    const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
    if (limitado(ip)) return resp(429, { erro: 'Muitos pedidos seguidos. Tente de novo mais tarde.' });

    const numero = digitos.length <= 11 ? '55' + digitos : digitos;
    const texto = [
        '🆘 Novo pedido de suporte — Zoons',
        '',
        'Empresa: ' + empresa,
        'WhatsApp: ' + whatsapp,
        'Responder: https://wa.me/' + numero,
        '',
        'Problema:',
        problema
    ].join('\n');

    try {
        await enviarTelegram(texto);
        return resp(200, { ok: true });
    } catch (e) {
        console.error('suporte:', e.message);
        return resp(502, { erro: 'Não foi possível enviar agora.' });
    }
};

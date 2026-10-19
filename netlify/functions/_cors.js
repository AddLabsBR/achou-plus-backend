/**
 * Cabeçalhos CORS compartilhados por todas as funções.
 *
 * Antes, cada função usava 'Access-Control-Allow-Origin': '*', o que deixa
 * QUALQUER site do mundo fazer requisições (via navegador) pra essas
 * funções. Como elas são protegidas por token do Firebase, o risco prático
 * era baixo, mas não custa nada fechar isso pro domínio real — é uma
 * camada a mais de segurança sem custo nenhum de funcionalidade.
 *
 * Se o seu domínio próprio (zoons.com.br) já estiver no ar, adicione ele
 * aqui na lista também.
 */

const ORIGENS_PERMITIDAS = [
    'https://zoons.netlify.app',
    'https://zoons.com.br',
    'https://www.zoons.com.br'
];

function corsHeaders(event, metodos) {
    const origem = (event && event.headers && (event.headers.origin || event.headers.Origin)) || '';
    const origemPermitida = ORIGENS_PERMITIDAS.includes(origem) ? origem : ORIGENS_PERMITIDAS[0];
    return {
        'Access-Control-Allow-Origin': origemPermitida,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': metodos || 'POST, OPTIONS',
        'Vary': 'Origin'
    };
}

module.exports = { corsHeaders, ORIGENS_PERMITIDAS };

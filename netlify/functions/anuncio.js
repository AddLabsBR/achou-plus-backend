/**
 * GET /a/:empresaId/:anuncioId   (redirecionado para esta função via netlify.toml)
 *
 * Devolve uma página HTML leve com título, descrição, foto e dados estruturados
 * do anúncio, para o Google indexar e para o WhatsApp/Facebook mostrarem prévia.
 * Quem é uma pessoa (não robô) é levado ao app: /#/anuncio/:empresaId/:anuncioId
 *
 * Não precisa de variáveis de ambiente: lê o Firestore pela API REST pública
 * (as regras já permitem leitura pública de empresas aprovadas e dos anúncios).
 */
const PROJECT_ID = 'achou-plus';
const API_KEY = 'AIzaSyCL47mY9G1aHQRsHg76nwYzbvAgej3m6EI'; // chave web do Firebase (já é pública no site)
const SITE = 'https://zoons.com.br';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = f => {
    if (!f) return null;
    if ('stringValue' in f) return f.stringValue;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f) return f.doubleValue;
    if ('booleanValue' in f) return f.booleanValue;
    if ('arrayValue' in f) return (f.arrayValue.values || []).map(val);
    return null;
};
const plano = doc => { const o = {}; Object.entries(doc.fields || {}).forEach(([k, v]) => { o[k] = val(v); }); return o; };
const get = async path => {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}?key=${API_KEY}`);
    return r.ok ? plano(await r.json()) : null;
};

exports.handler = async event => {
    const m = (event.path || '').match(/\/a\/([^/]+)\/([^/?#]+)/);
    const [empresaId, anuncioId] = m ? [decodeURIComponent(m[1]), decodeURIComponent(m[2])] : [];
    const app = `${SITE}/#/anuncio/${empresaId}/${anuncioId}`;
    const naoAchou = { statusCode: 302, headers: { Location: SITE } };
    if (!empresaId || !anuncioId || /[^\w-]/.test(empresaId + anuncioId)) return naoAchou;

    const [emp, an] = await Promise.all([get(`empresas/${empresaId}`), get(`empresas/${empresaId}/anuncios/${anuncioId}`)]);
    if (!emp || !an || emp.status !== 'aprovado' || an.ativo === false) return naoAchou;

    const foto = Array.isArray(an.fotos) && an.fotos[0] ? (typeof an.fotos[0] === 'string' ? an.fotos[0] : an.fotos[0].url) : '';
    const preco = typeof an.preco === 'number' ? 'R$ ' + an.preco.toLocaleString('pt-BR') : '';
    const titulo = `${an.titulo || 'Anúncio'}${preco ? ' — ' + preco : ''} | ${emp.nome || 'Zoons'}`;
    const desc = String(an.descricao || `${an.titulo || ''} em ${emp.nome || ''}. ${an.categoria || ''}. Veja no Zoons.`).replace(/\s+/g, ' ').slice(0, 155);
    const url = `${SITE}/a/${empresaId}/${anuncioId}`;
    const ld = {
        '@context': 'https://schema.org',
        '@type': an.categoria === 'Imóveis' || an.categoria === 'Automóveis' || an.categoria === 'Celulares' || an.categoria === 'Informática' ? 'Product' : 'Service',
        name: an.titulo, description: desc, image: foto || undefined, category: an.categoria,
        provider: { '@type': 'LocalBusiness', name: emp.nome },
        offers: typeof an.preco === 'number' ? { '@type': 'Offer', priceCurrency: 'BRL', price: an.preco, url } : undefined
    };
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Zoons">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">${foto ? `<meta property="og:image" content="${esc(foto)}">` : ''}
<meta name="twitter:card" content="${foto ? 'summary_large_image' : 'summary'}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<script>location.replace(${JSON.stringify(app)});</script>
<noscript><meta http-equiv="refresh" content="0;url=${esc(app)}"></noscript></head>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 20px">
<h1>${esc(an.titulo)}</h1>${foto ? `<p><img src="${esc(foto)}" alt="${esc(an.titulo)}" style="max-width:100%;border-radius:12px"></p>` : ''}
<p><b>${esc(preco)}</b> · ${esc(an.categoria)} · ${esc(emp.nome)}</p><p>${esc(an.descricao || '')}</p>
<p><a href="${esc(app)}">Ver anúncio no Zoons</a></p></body></html>`;
    return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' }, body: html };
};

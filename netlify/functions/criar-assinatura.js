/**
 * POST /.netlify/functions/criar-assinatura
 * Cabeçalho: Authorization: Bearer <ID token do Firebase Auth>
 *
 * Cria uma assinatura recorrente (preapproval) no Mercado Pago para a
 * empresa vinculada ao usuário logado, e devolve o link de pagamento.
 */

const admin = require('firebase-admin');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = admin.firestore();

// ---- Ajuste aqui o plano pago da Zoons ----
// Os primeiros LIMITE_FUNDADORES negócios pagam PRECO_FUNDADOR para sempre.
// A partir do negócio de número (LIMITE_FUNDADORES + 1), o preço vira PRECO_PADRAO, automaticamente.
const LIMITE_FUNDADORES = 15;
const PRECO_FUNDADOR = 29.90;
const PRECO_PADRAO = 49.90;

const PLANO_DESTAQUE = {
    frequency: 1,
    frequency_type: 'months',
    currency_id: 'BRL'
};

// Contador global de vagas de fundador já ocupadas (documento único em Firestore)
const CONTADOR_REF = db.collection('contadores').doc('fundadores');

// Reserva uma vaga de fundador de forma segura, mesmo com vários cadastros ao mesmo tempo.
// Retorna { fundador: true/false, preco: number }.
async function reservarVagaOuPrecoPadrao() {
    return db.runTransaction(async (tx) => {
        const doc = await tx.get(CONTADOR_REF);
        const total = doc.exists ? (doc.data().total || 0) : 0;

        if (total < LIMITE_FUNDADORES) {
            tx.set(CONTADOR_REF, { total: total + 1 }, { merge: true });
            return { fundador: true, preco: PRECO_FUNDADOR };
        }
        return { fundador: false, preco: PRECO_PADRAO };
    });
}

// TROQUE pela URL real do seu site publicado
const BACK_URL = 'https://zoons.netlify.app/';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

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

    const snap = await db.collection('empresas').where('uid', '==', uid).limit(1).get();
    if (snap.empty) {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Nenhuma empresa encontrada para esta conta.' }) };
    }
    const empresaDoc = snap.docs[0];
    const empresa = empresaDoc.data();

    // O e-mail pode não estar salvo no documento da empresa (cadastros antigos) —
    // nesse caso, buscamos direto do Firebase Auth como reserva.
    let payerEmail = empresa.email;
    if (!payerEmail) {
        try {
            const userRecord = await admin.auth().getUser(uid);
            payerEmail = userRecord.email;
        } catch (err) {
            console.error('Não foi possível obter o e-mail do usuário:', err);
        }
    }

    if (!payerEmail) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível identificar o e-mail da conta. Entre em contato com o suporte.' }) };
    }

    // Já tem vaga de fundador reservada de uma tentativa anterior? Não conta de novo.
    const jaEraFundador = empresa.fundador === true;
    const { fundador, preco } = jaEraFundador
        ? { fundador: true, preco: PRECO_FUNDADOR }
        : await reservarVagaOuPrecoPadrao();

    const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preapproval = new PreApproval(client);

    let resultado;
    try {
        resultado = await preapproval.create({
            body: {
                reason: fundador ? 'Zoons Plano Destaque · Fundador' : 'Zoons Plano Destaque',
                external_reference: empresaDoc.id,
                payer_email: payerEmail,
                auto_recurring: {
                    frequency: PLANO_DESTAQUE.frequency,
                    frequency_type: PLANO_DESTAQUE.frequency_type,
                    transaction_amount: preco,
                    currency_id: PLANO_DESTAQUE.currency_id
                },
                back_url: BACK_URL,
                status: 'pending'
            }
        });
    } catch (err) {
        console.error('Erro ao criar preapproval no Mercado Pago:', err);
        // Se a criação falhou e a vaga era nova (não reaproveitada), devolve a vaga ao contador
        if (fundador && !jaEraFundador) {
            await CONTADOR_REF.set({ total: admin.firestore.FieldValue.increment(-1) }, { merge: true }).catch(() => {});
        }
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível iniciar a assinatura. Tente novamente.' }) };
    }

    await empresaDoc.ref.update({
        assinatura_id: resultado.id,
        assinatura_status: 'pendente',
        plano: 'destaque',
        fundador: fundador,
        preco_mensal: preco
    });

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ init_point: resultado.init_point }) };
};

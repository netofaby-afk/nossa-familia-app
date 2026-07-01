const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function getFirebaseApp() {
  if (getApps().length) return getApps()[0];

  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

function brazilDateParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) values[part.type] = part.value;

  return `${values.year}-${values.month}-${values.day}`;
}

function dateAtNoon(dateString) {
  return new Date(`${dateString}T12:00:00-03:00`);
}

function daysBetween(todayString, dueString) {
  return Math.round((dateAtNoon(dueString) - dateAtNoon(todayString)) / 86400000);
}

function formatBRL(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

async function sendPush(title, message) {
  const response = await fetch("https://api.onesignal.com/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${process.env.ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: process.env.ONESIGNAL_APP_ID,
      target_channel: "push",
      filters: [
        {
          field: "tag",
          key: "familia",
          relation: "=",
          value: "principal",
        },
      ],
      headings: { en: title, pt: title },
      contents: { en: message, pt: message },
      url: process.env.APP_URL || undefined,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`OneSignal ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

exports.handler = async (event) => {
  const required = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
    "ONESIGNAL_APP_ID",
    "ONESIGNAL_API_KEY",
  ];

  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    return {
      statusCode: 500,
      body: JSON.stringify(
        { error: `VariÃ¡veis ausentes: ${missing.join(", ")}` },
        null,
        2
      ),
    };
  }

  try {
    getFirebaseApp();

    const db = getFirestore();
    const ref = db.collection("families").doc("principal");
    const snap = await ref.get();

    if (!snap.exists) {
      return {
        statusCode: 404,
        body: JSON.stringify(
          { error: "Documento families/principal nÃ£o encontrado." },
          null,
          2
        ),
      };
    }

    const data = snap.data() || {};
    const transactions = Array.isArray(data.transactions)
      ? data.transactions
      : [];

    const today = brazilDateParts();
    const force =
      event.queryStringParameters &&
      event.queryStringParameters.force === "1";

    const diagnostics = transactions.map((item) => ({
      title: item && item.title,
      type: item && item.type,
      paid: !!(item && item.paid),
      date: item && item.date,
      days:
        item && typeof item.date === "string"
          ? daysBetween(today, item.date)
          : null,
    }));

    if (force) {
      const result = await sendPush(
        "Teste automÃ¡tico Nossa FamÃ­lia",
        `A funÃ§Ã£o do Netlify estÃ¡ conectada ao OneSignal. Data considerada: ${today}.`
      );

      await ref.set(
        {
          notificationDiagnostic: {
            ranAt: new Date().toISOString(),
            today,
            force: true,
            transactionCount: transactions.length,
            oneSignalResult: result,
          },
        },
        { merge: true }
      );

      return {
        statusCode: 200,
        body: JSON.stringify(
          {
            ok: true,
            mode: "force-test",
            today,
            transactionCount: transactions.length,
            oneSignalResult: result,
            diagnostics,
          },
          null,
          2
        ),
      };
    }

    const unpaidExpenses = transactions.filter(
      (item) =>
        item &&
        item.type === "expense" &&
        !item.paid &&
        typeof item.date === "string"
    );

    const groups = {
      overdue: [],
      today: [],
      twoDays: [],
      fiveDays: [],
    };

    for (const item of unpaidExpenses) {
      const days = daysBetween(today, item.date);

      if (days < 0) groups.overdue.push(item);
      else if (days === 0) groups.today.push(item);
      else if (days === 2) groups.twoDays.push(item);
      else if (days === 5) groups.fiveDays.push(item);
    }

    const alertLog = data.notificationLog || {};
    const sent = [];

    async function sendGroup(key, title, items, phrase) {
      if (!items.length) return;

      const logKey = `${today}_${key}`;
      if (alertLog[logKey]) return;

      const total = items.reduce(
        (sum, item) => sum + Number(item.value || 0),
        0
      );

      const count = items.length;

      const message =
        count === 1
          ? `${items[0].title} â ${formatBRL(items[0].value)} ${phrase}.`
          : `${count} contas, total de ${formatBRL(total)}, ${phrase}.`;

      const oneSignalResult = await sendPush(title, message);

      alertLog[logKey] = new Date().toISOString();
      sent.push({ logKey, title, message, oneSignalResult });
    }

    await sendGroup(
      "overdue",
      "Contas vencidas",
      groups.overdue,
      "estÃ£o vencidas"
    );

    await sendGroup(
      "today",
      "Vence hoje",
      groups.today,
      "vencem hoje"
    );

    await sendGroup(
      "twoDays",
      "Vencimento em 2 dias",
      groups.twoDays,
      "vencem em 2 dias"
    );

    await sendGroup(
      "fiveDays",
      "Vencimento em 5 dias",
      groups.fiveDays,
      "vencem em 5 dias"
    );

    const trimmedLog = Object.fromEntries(
      Object.entries(alertLog)
        .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
        .slice(0, 120)
    );

    await ref.set(
      {
        notificationLog: trimmedLog,
        notificationLastRun: new Date().toISOString(),
        notificationDiagnostic: {
          ranAt: new Date().toISOString(),
          today,
          transactionCount: transactions.length,
          unpaidExpenseCount: unpaidExpenses.length,
          counts: {
            overdue: groups.overdue.length,
            today: groups.today.length,
            twoDays: groups.twoDays.length,
            fiveDays: groups.fiveDays.length,
          },
          sentCount: sent.length,
        },
      },
      { merge: true }
    );

    return {
      statusCode: 200,
      body: JSON.stringify(
        {
          ok: true,
          today,
          transactionCount: transactions.length,
          unpaidExpenseCount: unpaidExpenses.length,
          counts: {
            overdue: groups.overdue.length,
            today: groups.today.length,
            twoDays: groups.twoDays.length,
            fiveDays: groups.fiveDays.length,
          },
          sent,
          diagnostics,
        },
        null,
        2
      ),
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: 500,
      body: JSON.stringify(
        {
          ok: false,
          error: error.message,
          stack: error.stack,
        },
        null,
        2
      ),
    };
  }
};

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '8mb' }));
app.use(express.static(__dirname));

const allowedCategories = new Set([
  'Кино и видео', 'Музыка', 'Книги', 'Облако', 'Софт', 'Игры',
  'Связь', 'Фитнес', 'Образование', 'Доставка', 'Финансы', 'Другое'
]);

function sanitizeCandidate(candidate) {
  return {
    candidate_id: String(candidate.candidate_id || '').slice(0, 80),
    suggested_name: String(candidate.suggested_name || '').slice(0, 120),
    merchant_key: String(candidate.merchant_key || '').slice(0, 180),
    cadence: String(candidate.cadence || '').slice(0, 40),
    confidence: Math.max(0, Math.min(1, Number(candidate.confidence || 0))),
    typical_amount: Number(candidate.typical_amount || 0),
    evidence: Array.isArray(candidate.evidence)
      ? candidate.evidence.slice(0, 12).map((e) => ({
          transaction_id: String(e.transaction_id || '').slice(0, 80),
          date: String(e.date || '').slice(0, 20),
          amount: Number(e.amount || 0),
          description: String(e.description || '').slice(0, 260)
        }))
      : []
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
  });
});

app.post('/api/deepseek/validate', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const candidates = raw.slice(0, 80).map(sanitizeCandidate).filter(c => c.candidate_id && c.evidence.length >= 2);

    if (!candidates.length) {
      return res.json({ mode: 'deterministic', subscriptions: [], message: 'Нет кандидатов для AI-проверки.' });
    }

    if (!process.env.DEEPSEEK_API_KEY) {
      return res.json({
        mode: 'deterministic',
        subscriptions: candidates.map(c => ({
          candidate_id: c.candidate_id,
          is_subscription: true,
          name: c.suggested_name || c.merchant_key || 'Повторяющийся платёж',
          category: 'Другое',
          confidence_adjustment: 0,
          reason: 'DeepSeek API не настроен; показан результат локального детектора.'
        })),
        message: 'Добавьте DEEPSEEK_API_KEY в .env, чтобы включить AI-проверку.'
      });
    }

    const system = `Ты — финансовый классификатор повторяющихся платежей. Тебе передают ТОЛЬКО кандидатов, уже найденных детерминированным алгоритмом в банковской выписке.\n\nКРИТИЧЕСКИЕ ПРАВИЛА:\n1. НИКОГДА не придумывай сервисы, транзакции, суммы или даты.\n2. Возвращай только candidate_id, которые присутствуют во входном JSON.\n3. Нельзя добавлять новую подписку, если ее нет среди кандидатов.\n4. is_subscription=true только если evidence действительно похож на подписку/регулярный платёж.\n5. Переводы между людьми, зарплата, возвраты, покупки разового характера, пополнения, налоги и снятие наличных — не подписки.\n6. Название сервиса можно нормализовать, но оно должно быть очевидно связано с description из evidence.\n7. Выведи только JSON.\n\nФормат JSON: {"results":[{"candidate_id":"...","is_subscription":true,"name":"...","category":"Другое","confidence_adjustment":0.0,"reason":"кратко"}]}. category только из списка: ${[...allowedCategories].join(', ')}.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
        thinking: { type: 'disabled' },
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Проверь кандидатов. json:\n${JSON.stringify({ candidates })}` }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`DeepSeek ${response.status}: ${body.slice(0, 400)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { results: [] }; }

    const byId = new Map(candidates.map(c => [c.candidate_id, c]));
    const seen = new Set();
    const subscriptions = [];

    for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
      const id = String(item?.candidate_id || '');
      const source = byId.get(id);
      if (!source || seen.has(id)) continue; // Anti-hallucination gate.
      seen.add(id);

      const category = allowedCategories.has(item.category) ? item.category : 'Другое';
      // Display name is derived from the file evidence, not invented by the model.
      // DeepSeek may classify/category/explain, but cannot rename a payment into an unrelated service.
      const safeName = source.suggested_name || source.merchant_key || 'Повторяющийся платёж';

      subscriptions.push({
        candidate_id: id,
        is_subscription: item.is_subscription === true,
        name: safeName || 'Повторяющийся платёж',
        category,
        confidence_adjustment: Math.max(-0.25, Math.min(0.15, Number(item.confidence_adjustment || 0))),
        reason: String(item.reason || '').slice(0, 280),
        evidence_count: source.evidence.length,
        source_guard: true
      });
    }

    // Candidates omitted by AI are treated as not confirmed, never auto-created.
    res.json({ mode: 'deepseek', subscriptions, model: payload?.model || process.env.DEEPSEEK_MODEL });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'AI validation failed', details: String(error.message || error).slice(0, 500) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sber AI Scanner: http://localhost:${PORT}`);
  console.log(`Для телефона в этой Wi-Fi сети откройте http://<IP-компьютера>:${PORT}`);
});

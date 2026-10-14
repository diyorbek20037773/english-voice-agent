# Railway'ga joylash — qadam-baqadam

Yangi arxitektura: **bitta servis** (`web`). n8n yoʻq, Postgres yoʻq, volume yoʻq.
Railway'ga kirish va toʻlov maʼlumotlarini **oʻzingiz** kiritasiz — men ularni soʻramayman.

## 0. Tayyorgarlik (kompyuterda, bir marta)

```powershell
cd D:\myprojects\hr_ai_assistant_agent
pnpm setup:secrets --openai-key-file docs/apikey.md
```

Bu `railway-variables/web.env` faylini tayyorlaydi (production uchun **alohida** kirish tokeni va
OpenAI kalitingiz bilan). Fayl gitignore qilingan — GitHub'ga chiqmaydi.

## 1. Loyiha yaratish

1. https://railway.com → Login (GitHub bilan) → **Hobby** rejasini tanlang.
2. **New Project** → **Deploy from GitHub repo** → (birinchi marta) Railway GitHub ilovasiga
   `english-voice-agent` reposiga ruxsat bering → reponi tanlang.
3. Railway `Dockerfile` ni oʻzi topadi va build qiladi. Birinchi deploy oʻzgaruvchilar yoʻqligi
   uchun **xato bilan tugashi normal** — 2-qadamdan keyin qayta ishga tushadi.

## 2. Oʻzgaruvchilar (Variables)

Servis → **Variables** → **Raw Editor** → `railway-variables/web.env` ichidagi hamma narsani
nusxalab qoʻying → **Update Variables**.

| Oʻzgaruvchi | Qiymat | Izoh |
|---|---|---|
| `OPENAI_API_KEY` | `sk-…` (maxfiy) | Faqat backendda. Brauzerga hech qachon bormaydi |
| `APP_ACCESS_TOKEN` | 30 belgili token (maxfiy) | Telefonni "unlock" qilish uchun |
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | Domen shu portga yoʻnaltiriladi |
| `TRUST_PROXY_HOPS` | `1` | Railway proxy'si orqali IP/HTTPS ni toʻgʻri aniqlash |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-live-transcribe` | |
| `OPENAI_ANSWER_MODEL` | `gpt-6-luna` | Quick va Detailed (default) |
| `OPENAI_ANSWER_MODEL_DETAILED` | boʻsh | `gpt-6.1-sol` qoʻysangiz sifatliroq, ~20× qimmat |
| `OPENAI_QUICK_REASONING` | `none` | |
| `OPENAI_DETAILED_REASONING` | `low` | |
| `ANSWER_DAILY_LIMIT` | `200` | Kunlik javob chegarasi (byudjet himoyasi) |
| `CANDIDATE_PROFILE` (ixtiyoriy) | Oʻzingiz haqingizdagi faktlar (inglizcha) | Faqat shaxsiy savollarda ishlatiladi |

## 3. Sozlamalar (Settings)

| Joy | Qiymat |
|---|---|
| Source → Branch | `main` |
| Build → Builder | Dockerfile (avtomatik) |
| Deploy → Healthcheck Path | `/healthz` |
| Deploy → Healthcheck Timeout | `60` |
| Deploy → Serverless (App Sleeping) | **OʻCHIQ** (yoqilsa birinchi javob sekinlashadi) |
| Deploy → Restart Policy | On Failure |
| Deploy → Replicas | **1** (sessiyalar xotirada saqlanadi) |
| Deploy → Region | **EU West (Amsterdam)** — `europe-west4-drams3a` |

Sozlamalarni oʻzgartirgach **Deploy** (yoki Redeploy) bosing — Serverless kabi sozlamalar faqat
yangi deploy'da kuchga kiradi.

Region haqida: Toshkent uchun Amsterdam — yaxshi birinchi tanlov, lekin kafolat emas. Volume
yoʻqligi uchun regionni keyin oʻzgartirish oson va toʻxtovsiz. Avval oʻlchang (5-qadam).

## 4. Domen

Settings → **Networking** → **Generate Domain** → port soʻralsa `3000`.
Manzil: `https://<nom>.up.railway.app`. Server bu manzilni Railway bergan `RAILWAY_PUBLIC_DOMAIN`
dan **oʻzi oladi** — `ALLOWED_ORIGIN` qoʻyish shart emas. Domensiz ilova ishga tushmaydi
(`${{RAILWAY_PUBLIC_DOMAIN}}` orqali). Oʻz domeningiz shart emas.

## Agar "Healthcheck failed" chiqsa

**Build Logs** emas, **Deploy Logs** ni oching — u yerda sabab yozilgan boʻladi, masalan:

```
Invalid or missing environment variables:
  - ALLOWED_ORIGIN: Invalid input: expected string, received undefined
Hints:
  - Found "ALLOWED_ORGN" — did you mean "ALLOWED_ORIGIN"? Rename it.
  - ... On Railway: Settings → Networking → Generate Domain, then redeploy.
```

Har bir `Hints` qatori nima qilish kerakligini aytadi. Eng koʻp uchraydigan sabablar: domen
yaratilmagan; `OPENAI_API_KEY` / `APP_ACCESS_TOKEN` yoʻq yoki nomi xato yozilgan.

## 5. Tekshirish

```powershell
# 1) Sogʻliq:
curl https://<nom>.up.railway.app/healthz        # {"status":"ok"}

# 2) Toʻliq real test + 20 savollik tezlik oʻlchovi (~$0.01 dan kam):
pnpm smoke:real --url https://<nom>.up.railway.app --env railway-variables/web.env --latency 20
```

Natija `docs/results/` ga saqlanadi (p50/p95). Keyin telefonda
[manual-iphone-test.md](manual-iphone-test.md) roʻyxatini bajaring.

## 6. Eski (n8n davri) servislar

Men Railway'da **hech qanday servis yaratmaganman** (Railway hisobingizga kirish imkonim yoʻq edi).
Agar oldingi rejaga koʻra oʻzingiz yaratgan boʻlsangiz, yangi ilova telefonda ishlashini
tekshirgandan **keyin** quyidagilarni oʻchiring (Settings → Danger → Delete):

- `n8n` servisi va uning volume'i (`/home/node/.n8n`)
- `Postgres` servisi (ilova endi bazadan foydalanmaydi)

## 7. Ixtiyoriy: Infrastructure as Code

`.railway/railway.ts` — yuqoridagi sozlamalarning kod koʻrinishi (rasmiy `railway` SDK turlari bilan
tekshirilgan, lekin men uni qoʻllamaganman). Ishlatish uchun Railway CLI:

```powershell
npm install -g @railway/cli
railway login
railway link          # loyihani tanlang
railway config plan   # oʻzgarishlarni koʻring
railway config apply
```

Maxfiy qiymatlar (`OPENAI_API_KEY`, `APP_ACCESS_TOKEN`) faylda yoʻq — `preserve()` dashboard'dagi
qiymatlarni saqlab qoladi.

## Xarajatlar

Hobby: $5/oy, ichida $5 foydalanish krediti. Narxlar: RAM ~$10 / GB-oy, CPU ~$20 / vCPU-oy
(soniyalab hisoblanadi). Lokal Docker'da oʻlchandi: boʻsh holatda **~42 MB RAM**, CPU ~0%.
Bu taxminan $0.4/oy RAM degani — CPU va trafik qoʻshilsa ham odatda $5 kredit ichida qoladi,
lekin Railway → Metrics/Usage boʻlimida haqiqiy sarfni tekshirib turing.
OpenAI xarajati alohida (README → Narxlar).

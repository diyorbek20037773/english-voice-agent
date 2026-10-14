# English Voice Agent

Ingliz tilida texnik intervyuga tayyorlanish uchun shaxsiy yordamchi. Telefonda gapirasiz → ilova
gapingizni jonli ravishda inglizcha matnga aylantiradi → savolingizga inglizcha javob oqim
(stream) koʻrinishida chiqadi. Ilovaning interfeysi, transkript va javoblar — faqat ingliz tilida.

**Arxitektura (oddiy):** bitta Railway servis. Ichida React veb-ilova + Node.js (Fastify) backend.
Telefon mikrofoni → OpenAI Realtime (WebRTC) → jonli transkript. Savol → backend → OpenAI →
javob oqimi → telefon ekrani. n8n ham, maʼlumotlar bazasi ham yoʻq.

> **Ovoz manbalari (Mic / Laptop / Both):**
> - **Mic** — mikrofon: sizning ovozingiz va noutbuk karnayidan baland chiqqan ovoz. Telefonda faqat shu.
> - **Laptop** — noutbukning oʻz ovozi (Zoom, Meet, YouTube…) raqamli, toza olinadi; quloqchinda ham
>   ishlaydi. Faqat kompyuterdagi **Chrome yoki Edge** da.
> - **Both** — Laptop + Mic birga (bunda quloqchin taqing, aks holda karnay ovozi ikki marta eshitiladi).
>
> Zoom'dagi boshqa odamlarning ovozini transkripsiya qilishdan oldin ularning roziligini oling.

---

## 1. Kerakli narsalar

| Nima | Qayerdan |
|---|---|
| Node.js 22 yoki 24 | https://nodejs.org (LTS) — sizda allaqachon bor (v22.17) |
| Git | sizda bor |
| OpenAI API kaliti (`sk-…`) va hisobda kredit | https://platform.openai.com → API keys, Billing |
| GitHub hisobi | repo: `diyorbek20037773/english-voice-agent` |
| Railway hisobi (Hobby $5/oy) | https://railway.com |

pnpm oʻrnatish (bir marta, administrator shart emas):

```powershell
npm install -g pnpm@10
```

## 2. Kompyuterda ishga tushirish (lokal)

PowerShell yoki VS Code terminalida, loyiha papkasida:

```powershell
cd D:\myprojects\hr_ai_assistant_agent
pnpm install

# .env faylini yaratadi: tasodifiy kirish tokeni + OpenAI kalitingizni fayldan oladi.
# Kalit ekranga chiqmaydi, faqat .env ichiga yoziladi (.env GitHub'ga yuklanmaydi).
pnpm setup:secrets --openai-key-file docs/apikey.md

pnpm dev
```

Brauzerda oching: **http://localhost:5173**

- Agar kirish oynasi chiqsa, `.env` dagi `APP_ACCESS_TOKEN` ni kiriting. Uni umuman koʻrmaslik uchun
  `.env` ga `OPEN_ACCESS=true` qoʻshing.
- Pastdagi maydonga savol yozib **Enter** (yoki **↑**) bosing — javob oqim boʻlib chiqadi.
- **Start** → ruxsat bering → inglizcha savol bering — javob oʻzi chiqadi.

Hammasini tekshirish (TypeScript, 64 ta test, build, maxfiy kalit skaneri):

```powershell
pnpm check
```

## 3. Railway'ga joylash (internetdan telefonda ishlatish uchun)

Telefon mikrofoni faqat **HTTPS** manzilda ishlaydi, shuning uchun Railway kerak.
Qadam-baqadam yoʻriqnoma: **[docs/railway-setup.md](docs/railway-setup.md)**. Qisqacha:

1. Railway → **New Project** → **Deploy from GitHub repo** → `english-voice-agent`.
2. Servis → **Variables** → **Raw Editor** → `railway-variables/web.env` faylining ichini toʻliq
   nusxalab qoʻying (bu fayl kompyuteringizda, GitHub'da yoʻq).
3. **Settings** → Healthcheck Path: `/healthz`; Serverless: **oʻchiq**; Replicas: **1**;
   Region: **EU West (Amsterdam)**.
4. **Settings → Networking → Generate Domain** → manzil chiqadi: `https://…up.railway.app`.
5. Telefonda shu manzilni oching — ilova darhol ochiladi (`OPEN_ACCESS=true`, token soʻralmaydi).

Tekshirish (kompyuterdan, ~$0.01 dan kam):

```powershell
pnpm smoke:real --url https://SIZNING-MANZIL.up.railway.app --env railway-variables/web.env --latency 20
```

## 4. Ishlatish

| Tugma | Vazifasi |
|---|---|
| **Start** | Tanlangan manbani yoqadi (ruxsat soʻraydi), OpenAI bilan ulanadi |
| **Mic / Laptop / Both** | Ovoz manbai (faqat kompyuterda; Start'dan oldin tanlanadi) |
| **Pause / Resume** | Vaqtincha tinglamaydi (bu paytda audio yuborilmaydi — pul sarflanmaydi) |
| **Stop** | Mikrofonni butunlay oʻchiradi |
| **Clear** | Transkript va javoblarni tozalaydi |
| (avtomatik) | Savol eshitilsa (~0.8 s jimlikdan keyin) javob oʻzi chiqadi. Oddiy gaplar keyingi savol uchun kontekst boʻlib saqlanadi; "Okay", "Great" kabilar eʼtiborsiz qoldiriladi |
| **Quick / Detailed** | Qisqa yoki batafsil javob |
| **Edit** | Transkriptni pastdagi maydonga oladi: tuzating va **↑** (yoki Enter) bosing |

Javoblar ChatGPT'dagidek soʻzma-soʻz oqim (stream) boʻlib chiqadi. Kesilgan javob boʻlsa **Continue**,
kod bloklarida va har javob ostida **Copy** bor.

### Noutbukdagi Zoom/Meet ovozini olish (Laptop yoki Both)

1. Ilovani noutbukda **Chrome** yoki **Edge** da oching (Railway manzili yoki `http://localhost:5173`).
2. **Laptop** (yoki **Both**) ni tanlang → **Start**.
3. Brauzer "nimani ulashasiz" oynasini ochadi:
   - Zoom/Meet **brauzer tabida** boʻlsa: **Chrome tab** → oʻsha tabni tanlang → **"Share tab audio"** yoqilgan boʻlsin.
   - **Zoom ilovasi** (desktop) boʻlsa: **Entire screen** → **"Share system audio"** ni yoqing.
4. **Share** bosing. Tepada "Laptop audio on" chiqadi; transkript paydo boʻladi.
5. Toʻxtatish: **Stop** (yoki brauzerdagi "Stop sharing").

Ekran ulashish oynasi faqat ovozni olish uchun kerak — tasvir hech qayerga yuborilmaydi.
5 daqiqa gapirmasangiz, tejash uchun tinglash avtomatik toʻxtaydi.

## 5. Narxlar (2026-10-13 holatiga)

| Narsa | Narx |
|---|---|
| Transkripsiya `gpt-live-transcribe` | **$0.017 / daqiqa** (~$1 soatiga) — asosiy xarajat |
| Javob `gpt-6-luna` | $0.10 / 1M kirish, $0.50 / 1M chiqish token. Real oʻlchov: 43 javob ≈ **$0.0034** |
| Batafsil uchun `gpt-6.1-sol` (ixtiyoriy) | $2 / $10 per 1M token (~20 baravar qimmat) |
| Railway Hobby | $5/oy (ichida $5 foydalanish krediti); bitta servis odatda shu ichida |

$10 OpenAI byudjeti ≈ 9–10 soat jonli tinglash. Tinglamaganda **Pause** yoki **Stop** bosing.
Claude Max — bu faqat dasturlash uchun; ilovaning OpenAI xarajatini qoplamaydi.

## 6. Xavfsizlik

- OpenAI kaliti faqat backendda (`.env` / Railway Variables). Brauzerga faqat 60 soniyalik
  vaqtinchalik `ek_…` token beriladi.
- `docs/apikey.md`, `.env`, `railway-variables/` — **hech qachon GitHub'ga yuklanmaydi** (.gitignore).
  Sozlash tugagach, `docs/apikey.md` faylini oʻchirib qoʻyish tavsiya etiladi (kalit `.env` da bor).
- Kalit oshkor boʻlib qolsa: OpenAI → API keys → eski kalitni **Revoke** → yangi kalit →
  `.env` va Railway Variables'ni yangilang.
- **Ochiq kirish (`OPEN_ACCESS=true`):** token soʻralmaydi, lekin manzilni bilgan har kim ilovadan
  foydalana oladi va bu sizning OpenAI kreditingizdan sarflanadi. Himoya: kunlik javob limiti
  (`ANSWER_DAILY_LIMIT`), kunlik ovozli sessiya limiti (`VOICE_SESSIONS_PER_DAY`, standart 60),
  IP boʻyicha cheklovlar, qidiruv tizimlariga indekslash taqiqi. Eng ishonchli himoya —
  OpenAI dashboard'ida **Limits → budget** (oylik chegara) qoʻyish.
- Token himoyasini qaytarish: Railway'dan `OPEN_ACCESS` ni oʻchiring (`APP_ACCESS_TOKEN` saqlangan).

## 7. Muammolar

| Belgi | Yechim |
|---|---|
| "Microphone access was blocked" | iPhone: Settings → Safari → Microphone → Allow; sahifani yangilang |
| "The microphone needs HTTPS" | Railway `https://` manzilidan oching (LAN `http://` ishlamaydi) |
| "insufficient credit or quota" | OpenAI Billing'da kredit qoʻshing |
| "Microphone capture was interrupted" | Ilovaga qaytib, **Start** ni qayta bosing (iOS fonda mikrofonni toʻxtatadi) |
| "No laptop audio was shared" | Start → oynada **"Share tab audio"** / **"Share system audio"** belgisini yoqing |
| "Capturing laptop audio needs Chrome or Edge" | Kompyuterda Chrome/Edge ishlating; telefonda faqat **Mic** |
| Both rejimida soʻzlar takrorlanadi | Quloqchin taqing yoki faqat **Laptop** ni tanlang |
| Javob kelmaydi | Settings (⚙) → **Check model access** |

Batafsil: [docs/architecture.md](docs/architecture.md), [docs/testing.md](docs/testing.md),
[docs/verification.md](docs/verification.md), [docs/manual-iphone-test.md](docs/manual-iphone-test.md).

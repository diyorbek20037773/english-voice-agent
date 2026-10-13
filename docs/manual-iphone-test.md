# iPhone (Safari) qoʻlda tekshirish roʻyxati

Bu testni **haqiqiy iPhone** bilan siz bajarasiz. Kompyuterdagi "telefon oʻlchamidagi" oyna
haqiqiy iPhone mikrofon testi hisoblanmaydi. Android Chrome uchun ham shu roʻyxat ishlaydi.

**Kerak:** Railway'dagi `https://…up.railway.app` manzili, `railway-variables/web.env` dagi
`APP_ACCESS_TOKEN`, tinch xona. Test ~10 daqiqa, OpenAI xarajati ~$0.20 dan kam.

Har bir qatorga ✅ yoki ❌ va izoh yozing.

## A. Kirish va ulanish

| # | Qadam | Kutilgan natija |
|---|---|---|
| 1 | Safari'da manzilni oching | "English Voice Practice" kirish oynasi |
| 2 | Tokenni kiriting → **Unlock** | Asosiy ekran, holat: **Ready** |
| 3 | Notoʻgʻri token bilan urinib koʻring (boshqa brauzer oynasida) | "That access token is not correct." |
| 4 | **Start Listening** bosing | Safari mikrofon ruxsatini soʻraydi → **Allow** |
| 5 | Ruxsatdan keyin | Holat **Connecting…** → **Listening**, qizil **Mic on** belgisi, ovoz chizigʻi harakatlanadi |

## B. Manual rejim (default)

| # | Qadam | Kutilgan natija |
|---|---|---|
| 6 | Ayting: *"What is the difference between a process and a thread?"* | Live transcript'da soʻzlar gapirayotganingizda chiqadi (kulrang → qora) |
| 7 | **Answer** bosing | Holat **Transcribing…**, keyin javob kartasi, birinchi soʻzlar ~1–3 s ichida |
| 8 | Javob tugashini kuting | Kartada "First text … s · full answer … s" |
| 9 | **Answer** ni gapirmasdan bosing | "No speech was captured…" xabari, keraksiz soʻrov yoʻq |
| 10 | Kod savoli: *"Write a function to reverse a linked list in Python."* | Kod bloki + **Copy** tugmasi; Copy bosilganda "Copied" |

## C. Auto rejim

| # | Qadam | Kutilgan natija |
|---|---|---|
| 11 | **Auto** ni tanlang | Pastda "Auto: answers after 800 ms…" yozuvi |
| 12 | Toʻliq savol ayting va jim turing | ~1 s jimlikdan keyin javob oʻzi boshlanadi |
| 13 | *"Can you explain the difference between"* deb toʻxtang | Sariq "Waiting for the rest of the question…"; davom ettirsangiz ikkalasi bitta savol boʻladi |
| 14 | Settings (⚙) → silence slider'ni 1200 ms ga qoʻying | Sekinroq gapirganda erta yuborilmaydi |

## D. Pause, Stop, Clear, xatolar

| # | Qadam | Kutilgan natija |
|---|---|---|
| 15 | **Pause** → gapiring → **Resume** | Pause paytida transkript yoʻq, **Mic paused** belgisi |
| 16 | **Stop** | Mic belgisi yoʻqoladi; iPhone ekranidagi toʻq sariq mikrofon nuqtasi oʻchadi |
| 17 | **Clear** | Transkript va javoblar tozalanadi |
| 18 | Javob chiqayotganda yangi savol bering | Eski karta "Stopped: a newer question replaced this one." — yangisi chiqadi |
| 19 | **Detailed** tanlab savol bering | Uzunroq javob, "Detailed" belgisi |
| 20 | Ilovadan chiqib (Home), 30 s dan keyin qayting | Agar mikrofon toʻxtagan boʻlsa: "Microphone capture was interrupted… Press Start" |
| 21 | Samolyot rejimini yoqing → **Ask** | Tushunarli internet xatosi; typed savol maydoni ishlayveradi |
| 22 | Settings → **Check model access** | `gpt-6-luna` va `gpt-live-transcribe`: Available |
| 23 | Settings → Latency jadvali | Oʻlchovlar soni (n) oshgan |

## E. Natijani yozib qoʻying

- iPhone modeli va iOS versiyasi: …
- Internet (Wi‑Fi / mobil): …
- 7-qadamda birinchi matn vaqti (bir necha marta): …
- Muammolar: …

Natijalarni `docs/verification.md` ning "Owner device tests" boʻlimiga qoʻshing (yoki menga yuboring).

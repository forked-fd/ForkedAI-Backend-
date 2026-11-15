# Forked AI Backend v3

Backend للـ AI Bot في Forked Learn. **من غير أي dependencies** (Node ≥ 20 فقط)، والـ API متوافق مع الفرونت كما هو من غير تعديل.

## التشغيل
```bash
cp .env.example .env      # حط مفاتيح الـ providers + قيم Supabase
npm start                 # http://localhost:5000
npm test                  # 37 اختبار
```
في الفرونت: `VITE_API_BASE_URL=https://<backend>/api` (زي ما هو).

### Vercel
`api/index.js` + `vercel.json` (rewrite لكل المسارات). حط نفس متغيرات `.env` في Project → Environment Variables.
حدود Vercel: حجم الـ request ≤ 4.5MB (الفرونت بيصغّر الصور قبل الإرسال فمش مشكلة عادةً).

## الـ API (نفس العقد القديم)
| Endpoint | الوصف |
|---|---|
| `POST /api/chat` | JSON `{message, sessionId}` أو multipart `files`. لو `Accept: text/event-stream` → SSE streaming، غير كده JSON `{success,data:{response}}` |
| `POST /api/chat/clear` | مسح ذاكرة المحادثة |
| `GET /api/chat/history/:id` | محادثتك أنت بس |
| `POST /api/upload/audio` | تفريغ صوت (Deepgram) |
| `GET /api/health` | الحالة (من غير أسرار) |

## إيه اللي اتغيّر وليه
1. **Streaming حقيقي (SSE)** — الإجابة بتظهر مع أول token بدل ما تستنى الرد كله.
2. **Failover سريع + hedging** — لو موديل فشل بنروح للتاني فوراً؛ لو بطيء (>6s) بنشغّل التاني بالتوازي وأول واحد يرد يكسب. مفيش request بيستنى timeout طويل.
3. **الموديلات القديمة كانت ميتة**: `llama-3.3-70b-versatile` و`llama-3.1-8b-instant` (Groq، اتشالوا 16 أغسطس 2026)، `mixtral-8x7b-32768`، `deepseek-chat/reasoner` (اتشالوا 24 يوليو 2026). دلوقتي الموديلات بتتكتشف تلقائياً من `/models` وبتتعطل لوحدها لو اتشالت، وتقدر تفرضها بـ `GROQ_MODELS=...`.
4. **ذاكرة المحادثة بتفضل** — كانت `Map` في الذاكرة بتضيع مع كل cold start/instance على Vercel. دلوقتي بتتبني من `chat_messages` في Supabase بتوكن المستخدم نفسه (RLS)، مع الاحتفاظ بنص الملفات من الذاكرة لو متاح.
5. **حماية**: التوكن بتاع Supabase بقى بيتتحقق منه (قبل كده كان بيتتجاهل = أي حد يحرق مفاتيحك)، rate limit لكل مستخدم/IP، والـ `/history` مربوط بصاحبه.
6. **قراءة الملفات**: 150+ امتداد (ويب، موبايل، systems، data/ML، DevOps، ألعاب، blockchain…)، `.ipynb`، ترميزات UTF-16 وWindows-1256، كشف الملفات الباينري برسالة واضحة. الصور بتتعرف من الـ bytes مش من الـ MIME. حد 8 ملفات (القديم كان 5 والفرونت 8).
7. **الملفات الكبيرة**: تقدير tokens وتقصير ذكي (بداية+نهاية كل ملف)، واختيار provider بحدود أكبر تلقائياً بدل ما الطلب يفشل بـ 413.
8. **تنضيف الإجابة**: القديم كان بيمسح `<div>` من جوه `` `inline code` ``، ويدمّر المسافات (القوائم المتداخلة)، ويمسح رموز عربية زي ﷺ وﷲ. الجديد بيشتغل stream-safe ومش بيلمس الكود ولا المسافات، ويشيل `<think>`.
9. **`vercel.json` القديم كان غلط**: `routes` + `headers` مع بعض مش مسموحين في Vercel، و`CORS: *` مع credentials. اتصلّح وCORS بقى من `CORS_ORIGINS`.
10. السيرفر القديم **مكانش بيشتغل خارج Vercel في production** (`listen` بس لو `NODE_ENV != production`). والـ audio كان بيكتب على disk (read-only على Vercel). الاتنين اتصلحوا.
11. الـ HuggingFace القديم كان بيبعت prompt كنص خام للـ API القديم (deprecated) — اتحوّل للـ router المتوافق مع OpenAI.
12. أخطاء بشرية بس: مفيش أسماء providers أو stack traces بتوصل للمستخدم (بتتسجل في الـ logs).

## ملاحظات
- الـ rate limit والـ cache في الذاكرة لكل instance. لو عايز حد عالمي على Vercel استخدم Redis/Upstash.
- أسماء الموديلات الافتراضية best-effort لحد نوفمبر 2026 ومتحقق منها وقت التشغيل؛ راجع `GET /api/health?token=$HEALTH_TOKEN` لتشوف إيه اللي اتكتشف فعلاً.

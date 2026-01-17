# MHFC Ticket Monitor - Refactored

בוט מעקב אחר כרטיסים זמינים לאצטדיון סמי עופר (מכבי חיפה).

## שיפורים בגרסה המעודכנת

✅ **תיקונים קריטיים:**
- תיקון באג `findIndex(async)` - עכשיו משתמש ב-for loop
- בדיקת גרסת Node.js ותמיכה ב-fetch
- תיקון לוגיקת `PAUSE_ON_HIT` - עכשיו עובד נכון עם מצב מעקב

✅ **שיפור Stealth (חמקנות):**
- תמיכה ב-`playwright-extra` עם `stealth-plugin` (מתקין אוטומטית אם זמין)
- Fallback ל-stealth ידני אם החבילה לא מותקנת
- הסתרת סימני automation מתקדמים

✅ **שיפור זיהוי זמינות:**
- בדיקת קליק + חיפוש פאנל/מודאל/כפתור "הוסף לעגלה"
- אזהרה אם רוב הבלוקים לא נמצאו (מפה לא נטענה)
- **ניטור API** - מאזין לתעבורת רשת כדי לזהות נתוני זמינות מ-API (מהיר פי 100)
- לוגים מפורטים יותר

✅ **יציבות וביצועים:**
- החלפת `waitForTimeout` קבועים ב-`waitForSelector` חכם
- **חסימת משאבים מיותרים** - תמונות, פונטים, פרסומות, analytics (טעינה מהירה יותר)
- Backoff אוטומטי אחרי 3 שגיאות רצופות (60 שניות)
- שמירת session (cookies) לקובץ
- **בדיקת session alive** - בודק אם ה-session עדיין בתוקף לפני כל סבב

✅ **תמיכה ב-Proxy:**
- תמיכה מלאה ב-Proxy דרך משתני סביבה
- חשוב להריץ על שרתים מחו"ל כדי להימנע מחסימות IP

✅ **זיהוי Queue-it:**
- זיהוי אוטומטי אם הבוט נכנס לתור (Queue-it)
- התראה מיידית ב-Discord כשנכנסים לתור

✅ **ניקיון קוד:**
- פירוק לפונקציות קטנות ונוחות לתחזוקה
- לוגים שימושיים (כמה נמצאו, כמה null, וכו')
- תמיכה מלאה ב-env variables

## התקנה

```bash
# התקנת תלויות בסיסיות
npm install playwright dotenv

# התקנת playwright-extra עם stealth plugin (מומלץ מאוד!)
npm install playwright-extra playwright-extra-plugin-stealth

# התקנת דפדפן Chromium
npx playwright install chromium
```

**הערה:** אם `playwright-extra` לא מותקן, הבוט יעבוד עם stealth ידני (פחות מתקדם).

## הרצה

### דוגמה בסיסית:

```powershell
node tick-mhfc.js
```

### עם כל ההגדרות:

```powershell
$env:HEADFUL="1"; $env:DEBUG="1"; $env:PAUSE_ON_HIT="0"; $env:WEBHOOK_URL="YOUR_DISCORD_WEBHOOK"; $env:LOGIN_USERNAME="your_email@example.com"; $env:LOGIN_PASSWORD="your_password"; $env:SECTIONS="201,202,207"; $env:INTERVAL_MS="10000"; node tick-mhfc.js
```

## משתני סביבה (Environment Variables)

### הגדרות בסיסיות:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `URL` | `https://tickets.mhaifafc.com/Stadium/Index?eventId=5065` | כתובת דף המשחק |
| `SECTIONS` | `201,202,...,212` | בלוקים לבדיקה (מופרדים בפסיקים) |
| `INTERVAL_MS` | `10000` | זמן המתנה בין בדיקות (מילישניות) |

### הגדרות דפדפן:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `HEADFUL` | `0` | `1` = חלון דפדפן פתוח, `0` = headless |
| `DEBUG` | `0` | `1` = לוגים מפורטים |
| `PAUSE_ON_HIT` | `1` | `1` = עוצר כשיש זמינות, `0` = נכנס למצב מעקב |
| `VIEWPORT_W` | `1366` | רוחב חלון |
| `VIEWPORT_H` | `768` | גובה חלון |
| `DEVICE_SCALE_FACTOR` | `1` | קנה מידה |

### התחברות:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `LOGIN_USERNAME` | - | שם משתמש/אימייל |
| `LOGIN_PASSWORD` | - | סיסמה |
| `LOGIN_URL` | `https://auth.mhaifafc.com/` | דף התחברות |

### התראות:

| משתנה | תיאור |
|-------|--------|
| `WEBHOOK_URL` | כתובת Discord Webhook |
| `NTFY_TOPIC` | שם Topic ב-ntfy |
| `TELEGRAM_TOKEN` | Token של Telegram Bot (מ-@BotFather) |
| `TELEGRAM_CHAT_ID` | Chat ID שלך ב-Telegram |

### שמירת session:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `STORAGE_STATE_PATH` | `./state.json` | נתיב לשמירת session (cookies) |

### Proxy (אופציונלי):

| משתנה | תיאור |
|-------|--------|
| `PROXY_SERVER` | כתובת Proxy (למשל: `http://proxy.example.com:8080`) |
| `PROXY_USERNAME` | שם משתמש ל-Proxy (אם נדרש) |
| `PROXY_PASSWORD` | סיסמה ל-Proxy (אם נדרש) |

### API Monitoring:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `API_MONITORING` | `1` | `1` = מאזין ל-API responses, `0` = כבוי |

## דוגמאות שימוש

### 1. הרצה בסיסית עם Discord:

```powershell
$env:WEBHOOK_URL="https://discord.com/api/webhooks/YOUR_WEBHOOK"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 2. עם חלון דפדפן פתוח:

```powershell
$env:HEADFUL="1"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 3. בלוקים ספציפיים:

```powershell
$env:SECTIONS="207,208,209"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 4. עם DEBUG וללא עצירה:

```powershell
$env:DEBUG="1"; $env:PAUSE_ON_HIT="0"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 5. עם שמירת session:

```powershell
$env:STORAGE_STATE_PATH="./my-session.json"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 6. עם Proxy (מומלץ להריץ על שרתים):

```powershell
$env:PROXY_SERVER="http://proxy.example.com:8080"; $env:PROXY_USERNAME="user"; $env:PROXY_PASSWORD="pass"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 7. עם Telegram:

```powershell
$env:TELEGRAM_TOKEN="your_bot_token"; $env:TELEGRAM_CHAT_ID="your_chat_id"; $env:LOGIN_USERNAME="email@example.com"; $env:LOGIN_PASSWORD="password"; node tick-mhfc.js
```

### 8. עם .env file (מומלץ):

צור קובץ `.env` בתיקייה עם התוכן:
```
WEBHOOK_URL=your_discord_webhook
TELEGRAM_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
LOGIN_USERNAME=your_email@example.com
LOGIN_PASSWORD=your_password
HEADFUL=1
DEBUG=1
PAUSE_ON_HIT=0
```

ואז פשוט:
```powershell
node tick-mhfc.js
```

### איך להשיג Telegram Bot Token ו-Chat ID:

1. **Bot Token:**
   - פתח שיחה עם [@BotFather](https://t.me/BotFather) ב-Telegram
   - שלח `/newbot` ועקוב אחר ההוראות
   - תקבל Token - זה ה-`TELEGRAM_TOKEN`

2. **Chat ID:**
   - פתח שיחה עם [@userinfobot](https://t.me/userinfobot) ב-Telegram
   - הוא ישלח לך את ה-Chat ID שלך - זה ה-`TELEGRAM_CHAT_ID`

## איך זה עובד

1. **התחברות**: אם יש פרטי התחברות, הבוט מתחבר אוטומטית ושומר את ה-session
2. **טעינת דף**: טוען את דף המשחק ומחכה שהמפה תיטען
3. **סריקת בלוקים**: בודק כל בלוק (לפי `SECTIONS`) לזמינות
4. **זיהוי זמינות**: 
   - בודק className/aria/disabled
   - אם HEADFUL=1, גם לוחץ על הבלוק ובודק אם נפתח פאנל/מודאל
5. **התראה**: כשיש זמינות - שולח ל-Discord/ntfy + צפצוף
6. **מצב מעקב**: אם `PAUSE_ON_HIT=0`, נכנס למצב מעקב שבודק אם הזמינות עדיין קיימת

## פתרון בעיות

### המפה לא נטענת:
- ודא ש-`HEADFUL="1"` כדי לראות מה קורה
- בדוק אם יש CAPTCHA או חסימה
- נסה viewport גדול יותר: `$env:VIEWPORT_W="1600"; $env:VIEWPORT_H="900"`

### שגיאות חוזרות:
- הבוט יכנס ל-backoff אוטומטית אחרי 3 שגיאות
- בדוק את החיבור לאינטרנט
- ודא שהאתר לא חסם אותך

### התחברות לא עובדת:
- הרץ עם `HEADFUL="1"` כדי לראות מה קורה
- נסה להתחבר ידנית פעם אחת
- בדוק את `LOGIN_URL`

### Queue-it (תור):
- אם הבוט מזהה שהוא נכנס לתור, הוא ישלח התראה ב-Discord
- במקרה כזה, כדאי להיכנס ידנית ולעבור את התור
- אחרי שעברת את התור, הבוט ימשיך לעבוד כרגיל

## הערות חשובות

⚠️ **הבוט לא מוסיף כרטיסים לעגלה אוטומטית** - זה מנוגד לתנאי השימוש של אתרי כרטיסים.

✅ מה שהבוט כן עושה:
- מתריע כשיש זמינות
- פותח את הדף
- גולל לבלוק הרלוונטי
- לוחץ על הבלוק כדי לפתוח את מסך הבחירה
- **אתה** צריך להוסיף לעגלה ידנית

🔒 **אבטחה:**
- **לעולם אל תעלה את קובץ `.env` ל-GitHub!** הוא כבר ב-`.gitignore`
- השתמש ב-`.env.example` כדוגמה (ללא פרטים אמיתיים)
- אם אתה משתף את הקוד, ודא שהסרת את כל הפרטים האישיים

## רישיון

שימוש אישי בלבד. השתמש באחריות.

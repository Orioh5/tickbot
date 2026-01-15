# MHFC Ticket Monitor - Refactored

בוט מעקב אחר כרטיסים זמינים לאצטדיון סמי עופר (מכבי חיפה).

## שיפורים בגרסה המעודכנת

✅ **תיקונים קריטיים:**
- תיקון באג `findIndex(async)` - עכשיו משתמש ב-for loop
- בדיקת גרסת Node.js ותמיכה ב-fetch
- תיקון לוגיקת `PAUSE_ON_HIT` - עכשיו עובד נכון עם מצב מעקב

✅ **שיפור זיהוי זמינות:**
- בדיקת קליק + חיפוש פאנל/מודאל/כפתור "הוסף לעגלה"
- אזהרה אם רוב הבלוקים לא נמצאו (מפה לא נטענה)
- לוגים מפורטים יותר

✅ **יציבות וביצועים:**
- החלפת `waitForTimeout` קבועים ב-`waitForSelector` חכם
- Backoff אוטומטי אחרי 3 שגיאות רצופות (60 שניות)
- שמירת session (cookies) לקובץ

✅ **ניקיון קוד:**
- פירוק לפונקציות קטנות ונוחות לתחזוקה
- לוגים שימושיים (כמה נמצאו, כמה null, וכו')
- תמיכה מלאה ב-env variables

## התקנה

```bash
npm install playwright
npx playwright install chromium
```

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

### שמירת session:

| משתנה | ברירת מחדל | תיאור |
|-------|------------|--------|
| `STORAGE_STATE_PATH` | `./state.json` | נתיב לשמירת session (cookies) |

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

## הערות חשובות

⚠️ **הבוט לא מוסיף כרטיסים לעגלה אוטומטית** - זה מנוגד לתנאי השימוש של אתרי כרטיסים.

✅ מה שהבוט כן עושה:
- מתריע כשיש זמינות
- פותח את הדף
- גולל לבלוק הרלוונטי
- לוחץ על הבלוק כדי לפתוח את מסך הבחירה
- **אתה** צריך להוסיף לעגלה ידנית

## רישיון

שימוש אישי בלבד. השתמש באחריות.

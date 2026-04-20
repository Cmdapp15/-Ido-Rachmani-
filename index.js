const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params"); 
const formData = require("form-data");
const Mailgun = require("mailgun.js");
const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

// הגדרת Secrets - מפתחות מאובטחים
const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY");
const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
const PAYPAL_SECRET = defineSecret("PAYPAL_SECRET");

const mailgun = new Mailgun(formData);
const DOMAIN = 'naomisat.com';

// 1. פונקציית שליחת קוד אימות (מתוקנת עם לוגים וניקוי נתונים)
exports.sendVerificationCode = onCall({ 
    region: "us-central1", 
    secrets: [MAILGUN_API_KEY] 
}, async (request) => {
    const { email, deviceId } = request.data;
    
    // לוג לניטור - עוזר לראות מה מגיע מהפרונטאנד
    console.log(`Verification Request: Email: ${email}, DeviceId: ${deviceId}`);

    if (!email || !deviceId) {
        throw new HttpsError('invalid-argument', 'Email and Device ID are required.');
    }
    
    const cleanEmail = email.trim().toLowerCase();
    const cleanDeviceId = String(deviceId).trim(); // הבטחה שזה מחרוזת
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        // שמירת הקוד ב-Firestore עם תוקף ל-15 דקות
        await db.collection("verificationCodes").doc(cleanEmail).set({
            code,
            deviceId: cleanDeviceId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 15 * 60000))
        });

        // שליחה דרך Mailgun
        const mg = mailgun.client({ username: 'api', key: MAILGUN_API_KEY.value() });
        await mg.messages.create(DOMAIN, {
            from: `Naomi SAT <support@${DOMAIN}>`,
            to: [cleanEmail],
            subject: `Your Verification Code: ${code}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee;">
                    <h2>Verification Code</h2>
                    <p>Your security code for Naomi's English SAT is:</p>
                    <h1 style="background: #f4f4f4; padding: 10px; display: inline-block;">${code}</h1>
                    <p>This code will expire in 15 minutes.</p>
                </div>
            `
        });

        console.log(`Success: Code sent to ${cleanEmail}`);
        return { success: true, message: "Code sent successfully." };

    } catch (error) {
        console.error("Mailgun/Firestore Error:", error);
        throw new HttpsError('internal', 'Failed to complete the verification process.');
    }
});

// 2. פונקציית Webhook של PayPal (מעודכנת לזיהוי UID מדויק)
exports.paypalWebhook = onRequest({
    secrets: [MAILGUN_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_SECRET]
}, async (req, res) => {
    try {
        const event = req.body;
        console.log("PayPal Webhook Received:", event.event_type);
        
        if (event.event_type === 'CHECKOUT.ORDER.APPROVED' || event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const resource = event.resource;
            
            // חילוץ ה-UID (חשוב מאוד להתאמה למשתמש הנכון)
            const userId = resource.purchase_units ? resource.purchase_units[0].custom_id : resource.custom_id;
            const transactionId = resource.id;
            const payerEmail = resource.payer ? resource.payer.email_address : "User";

            if (!userId) {
                console.error("Webhook Error: No userId (custom_id) found in payload");
                return res.status(200).send("No userId found"); 
            }

            // עדכון Firestore - שימוש ב-merge למניעת דריסת נתונים קיימים
            await db.collection("users").doc(userId).set({
                isPremium: true,
                premiumSince: admin.firestore.FieldValue.serverTimestamp(),
                lastTransactionId: transactionId
            }, { merge: true });

            console.log(`Premium activated for UID: ${userId}`);

            // שליחת מייל אישור
            const mg = mailgun.client({ username: 'api', key: MAILGUN_API_KEY.value() });
            await mg.messages.create(DOMAIN, {
                from: `Naomi SAT <support@${DOMAIN}>`,
                to: [payerEmail],
                subject: "Welcome to Premium! 🎓",
                html: `<h3>Success! Your account is now Premium.</h3><p>Transaction ID: ${transactionId}</p><p>You now have full access to all materials.</p>`
            });
        }
        
        res.status(200).send("OK");
    } catch (err) {
        console.error("PayPal Webhook Error:", err);
        res.status(500).send("Internal Error");
    }
});

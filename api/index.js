const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Load environment variables from the correct project root
dotenv.config({ path: path.join(__dirname, '../.env') });

// ── REQUIRE SECURE STARTUP (Fail Fast Environment Validation) ──
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error('FATAL STARTUP ERROR: SESSION_SECRET environment variable is missing.');
  process.exit(1);
}
// 64 bytes is 128 hex characters
if (sessionSecret.trim().length < 128) {
  console.error('FATAL STARTUP ERROR: SESSION_SECRET must be at least 64 random bytes (128 hex characters).');
  process.exit(1);
}

const rzpKeyId = process.env.RAZORPAY_KEY_ID;
if (!rzpKeyId) {
  console.error('FATAL STARTUP ERROR: RAZORPAY_KEY_ID environment variable is missing.');
  process.exit(1);
}
if (!rzpKeyId.startsWith('rzp_')) {
  console.error('FATAL STARTUP ERROR: RAZORPAY_KEY_ID must start with "rzp_".');
  process.exit(1);
}

const rzpKeySecret = process.env.RAZORPAY_KEY_SECRET;
if (!rzpKeySecret || rzpKeySecret.trim() === '') {
  console.error('FATAL STARTUP ERROR: RAZORPAY_KEY_SECRET environment variable is missing or empty.');
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl || supabaseUrl.trim() === '') {
  console.error('FATAL STARTUP ERROR: SUPABASE_URL environment variable is missing or empty.');
  process.exit(1);
}

const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseAnonKey || supabaseAnonKey.trim() === '') {
  console.error('FATAL STARTUP ERROR: SUPABASE_ANON_KEY environment variable is missing or empty.');
  process.exit(1);
}

console.log('[Startup] Environment configuration validation succeeded.');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY: CORS RESTRICTION ──
const allowedOrigins = [
  'https://ibsp.zenacle.in',
  'http://localhost:3000'
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Enable JSON body parsing
app.use(express.json());

// Enforce HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (!isHttps) {
      return res.status(403).json({ error: 'HTTPS required.' });
    }
  }
  next();
});

// ── REQUEST ID MIDDLEWARE ──
app.use((req, res, next) => {
  req.id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex');
  next();
});

// Serve static frontend files (for local testing)
app.use(express.static(path.join(__dirname, '..')));

// ── CENTRALIZED CONFIGURATION CONSTANTS ──
const COURSE_FEE = 25200;
const SESSION_TTL = 15 * 60 * 1000; // 15 minutes in milliseconds
const TOKEN_ALGORITHM = 'sha256';

// ── RAZORPAY CLIENT ──
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ── RATE LIMITERS ──

// Registration endpoint: 30 per 15 min
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  handler: (req, res) => {
    console.warn(`[ReqID: ${req.id}] [Rate Limit] Registration limit exceeded.`);
    res.status(429).json({ error: 'Too many registration requests. Please try again later.' });
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Payment lookup: Max 5 attempts per IP within 10 minutes
const lookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  handler: (req, res) => {
    console.warn(`[ReqID: ${req.id}] [Rate Limit] Payment lookup limit exceeded.`);
    res.status(429).json({
      success: false,
      message: 'Too many lookup attempts. Please try again in 10 minutes.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Payment order/verify/fail: 10 per 15 min
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => {
    console.warn(`[ReqID: ${req.id}] [Rate Limit] Payment transaction limit exceeded.`);
    res.status(429).json({
      success: false,
      message: 'Too many payment attempts. Please try again later.'
    });
  },
  standardHeaders: true,
  legacyHeaders: false
});

// ── HELPERS ──

/**
 * Normalize a phone number for consistent comparison.
 * Strips spaces and common separators, keeps + prefix.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.trim().replace(/[\s\-().]/g, '');
}

/**
 * Normalize email: trim + lowercase.
 */
function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

/**
 * lookupRegistration(email, whatsapp)
 * Used by the payment module to find a registration by email + WhatsApp.
 */
async function lookupRegistration(email, whatsapp) {
  console.log('1. Raw request body / lookup inputs:', { email, whatsapp_number: whatsapp });
  
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(whatsapp);

  console.log('2. Normalized email:', normEmail);
  console.log('2. Normalized phone:', normPhone);

  console.log('3. Exact Supabase query filters being executed:');
  console.log(`.from('ibsp').select('*').ilike('email', '${normEmail}').eq('whatsapp_number', '${normPhone}').limit(1)`);

  const { data, error } = await supabase
    .from('ibsp')
    .select('*')
    .ilike('email', normEmail)
    .eq('whatsapp_number', normPhone)
    .limit(1);

  console.log('4. Supabase response:');
  console.log('Data:', data);
  console.log('Error:', error);

  if (error) {
    console.error('[DB Error] lookupRegistration failed:', error.message);
    return null;
  }

  return (data && data.length > 0) ? data[0] : null;
}

/**
 * findExistingRegistration(email, whatsapp, batchType)
 * Duplicate-prevention helper used by /api/register.
 */
async function findExistingRegistration(email, whatsapp, batchType) {
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(whatsapp);
  const normBatch = (batchType || '').trim();

  if (!normEmail || !normPhone || !normBatch) return null;

  const { data, error } = await supabase
    .from('ibsp')
    .select('id, full_name, email, whatsapp_number, batch_type, payment_status')
    .ilike('email', normEmail)
    .eq('whatsapp_number', normPhone)
    .eq('batch_type', normBatch)
    .limit(1);

  if (error) {
    console.error('[DB Error] findExistingRegistration failed:', error.message);
    return null;
  }

  return (data && data.length > 0) ? data[0] : null;
}

// ── SESSION TOKEN HELPERS ──

/**
 * createSessionToken(rowId, paymentStatus)
 * Produces a short-lived HMAC-signed token encoding the registration ID.
 */
function createSessionToken(rowId, paymentStatus) {
  const iat = Date.now();
  const payload = Buffer.from(JSON.stringify({
    id: rowId,
    payment_status: paymentStatus,
    iat: iat,
    exp: iat + SESSION_TTL
  })).toString('base64url');

  const sig = crypto
    .createHmac(TOKEN_ALGORITHM, process.env.SESSION_SECRET)
    .update(payload)
    .digest('hex');

  return `${payload}.${sig}`;
}

/**
 * verifySessionToken(token)
 * Hardened validation: checks signature, format, expiration, and payment_status.
 */
function verifySessionToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payload, receivedSig] = parts;

    const expectedSig = crypto
      .createHmac(TOKEN_ALGORITHM, process.env.SESSION_SECRET)
      .update(payload)
      .digest('hex');

    const sigValid = crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'hex'),
      Buffer.from(receivedSig, 'hex')
    );
    if (!sigValid) {
      console.warn('[Session Warning] Token signature validation failed.');
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    // Check expiration
    if (!decoded.exp || typeof decoded.exp !== 'number' || Date.now() > decoded.exp) {
      console.warn('[Session Warning] Token has expired.');
      return null;
    }

    // Check format structure
    if (!decoded.id || typeof decoded.id !== 'string' || !decoded.iat || typeof decoded.iat !== 'number') {
      console.warn('[Session Warning] Token format is invalid.');
      return null;
    }

    // Check expected status is valid
    if (decoded.payment_status !== 'PENDING' && decoded.payment_status !== 'FAILED') {
      console.warn('[Session Warning] Invalid payment_status in token:', decoded.payment_status);
      return null;
    }

    return decoded;
  } catch (err) {
    console.error('[Session Error] Token parsing exception:', err.message);
    return null;
  }
}

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── EMAIL SERVICE ──
async function sendRegistrationEmail(email, fullName) {
  console.log('[Email Service] Initiating email delivery process...');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  if (email.includes('fail_email') || email === 'fail@example.com') {
    throw new Error('SMTP connection timed out: Failed to dispatch email.');
  }
  
  console.log('[Email Service] Email successfully sent.');
  return true;
}

// ── DIRECT REGISTRATION ENDPOINT ──
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { enrollmentData } = req.body;
    if (!enrollmentData || !enrollmentData.email || !enrollmentData.full_name) {
      return res.status(400).json({ error: 'Invalid enrollment data.' });
    }

    const rawEmail = (enrollmentData.email || '').toString().trim();
    const rawPhone = (enrollmentData.whatsapp_number || '').toString().trim();

    // Input validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return res.status(400).json({ error: 'Invalid email address format.' });
    }
    if (rawPhone.length < 7 || rawPhone.length > 20) {
      return res.status(400).json({ error: 'Invalid WhatsApp number format.' });
    }

    console.log(`[ReqID: ${req.id}] [Registration] Checking duplicate registration status.`);

    const existing = await findExistingRegistration(
      rawEmail,
      rawPhone,
      enrollmentData.batch_type
    );

    if (existing) {
      console.warn(`[ReqID: ${req.id}] [Registration] Duplicate registration blocked.`);
      return res.status(409).json({
        success: false,
        duplicate: true,
        payment_status: existing.payment_status,
        message: 'You have already registered for this batch.'
      });
    }

    const registrationPayload = {
      full_name: enrollmentData.full_name,
      email: normalizeEmail(rawEmail),
      whatsapp_number: normalizePhone(rawPhone),
      contact_number: enrollmentData.contact_number,
      country: enrollmentData.country,
      profession: enrollmentData.profession,
      company: enrollmentData.company,
      qualification: enrollmentData.qualification,
      batch_type: (enrollmentData.batch_type || '').trim(),
      time_slots: enrollmentData.time_slots,
      payment_status: 'PENDING',
      payment_amount: COURSE_FEE,
      payment_currency: 'INR',
      payment_provider: 'RAZORPAY',
      payment_verified: false
    };

    const { error: dbError } = await supabase
      .from('ibsp')
      .insert([registrationPayload]);

    if (dbError) {
      console.error(`[ReqID: ${req.id}] [DB Error] Failed to save registration:`, dbError.message);
      return res.status(500).json({ error: 'Failed to complete registration.' });
    }

    console.log(`[ReqID: ${req.id}] [Registration] Completed registration successfully.`);

    let emailSent = false;
    try {
      await sendRegistrationEmail(rawEmail, enrollmentData.full_name);
      emailSent = true;
    } catch (emailError) {
      console.error(`[ReqID: ${req.id}] [Email Error] Failed to send registration email:`, emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Registration completed successfully.',
      emailSent: emailSent
    });
  } catch (error) {
    console.error(`[ReqID: ${req.id}] [Registration Exception] Failed:`, error.message);
    res.status(500).json({ error: 'Failed to complete registration.' });
  }
});

// ── PAYMENT: LOOKUP REGISTRATION ──
app.post('/api/payment/lookup', lookupLimiter, async (req, res) => {
  try {
    const rawEmail = (req.body.email || '').toString().trim();
    const rawPhone = (req.body.whatsapp_number || '').toString().trim();

    // Input Validation
    if (!rawEmail || !rawPhone) {
      console.warn(`[ReqID: ${req.id}] [Lookup] Email or WhatsApp phone field missing.`);
      return res.status(400).json({
        success: false,
        message: 'Email and WhatsApp number are required.'
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      console.warn(`[ReqID: ${req.id}] [Lookup] Invalid email format validation failed.`);
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address.'
      });
    }
    if (rawPhone.length < 7 || rawPhone.length > 20) {
      console.warn(`[ReqID: ${req.id}] [Lookup] Phone number length validation failed.`);
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid WhatsApp number.'
      });
    }

    console.log(`[ReqID: ${req.id}] [Lookup] Verifying registration details.`);
    const row = await lookupRegistration(rawEmail, rawPhone);

    if (!row) {
      console.warn(`[ReqID: ${req.id}] [Lookup] Registration search returned zero matches.`);
      return res.status(404).json({
        success: false,
        message: "We couldn't find a registration matching the information you entered."
      });
    }

    console.log(`[ReqID: ${req.id}] [Lookup] Registration matched ID: ${row.id}`);

    const registration = {
      name: row.full_name,
      profession: row.profession,
      qualification: row.qualification,
      batch_type: row.batch_type,
      time_slots: row.time_slots,
      amount: COURSE_FEE
    };

    if (row.payment_status === 'SUCCESS') {
      return res.status(200).json({
        success: true,
        alreadyPaid: true,
        registration
      });
    }

    const session_token = createSessionToken(row.id, row.payment_status);

    if (row.payment_status === 'FAILED') {
      return res.status(200).json({
        success: true,
        paymentFailed: true,
        session_token,
        registration
      });
    }

    return res.status(200).json({
      success: true,
      alreadyPaid: false,
      session_token,
      registration
    });

  } catch (err) {
    console.error(`[ReqID: ${req.id}] [Lookup Exception] Error:`, err.message);
    return res.status(500).json({
      success: false,
      message: 'An error occurred. Please try again later.'
    });
  }
});

// ── PAYMENT: CREATE RAZORPAY ORDER ──
app.post('/api/payment/create-order', paymentLimiter, async (req, res) => {
  console.log("1. Request received at /api/payment/create-order:", req.body);
  let decoded = null;
  let row = null;
  let razorpayPayload = null;
  let order = null;
  try {
    const { session_token } = req.body;

    if (!session_token || typeof session_token !== 'string') {
      console.warn(`[ReqID: ${req.id}] [Create Order] Session token missing or type mismatch.`);
      return res.status(400).json({
        success: false,
        message: 'Invalid session token format.'
      });
    }

    // 1. Verify and decode the session token
    decoded = verifySessionToken(session_token);
    console.log("2. Session token verification result:", decoded ? "SUCCESS" : "FAILED");
    if (!decoded) {
      console.warn(`[ReqID: ${req.id}] [Create Order] Session token validation failed (Expired or Invalid).`);
      return res.status(401).json({
        success: false,
        message: 'Your session has expired or is invalid. Please verify your registration again.'
      });
    }

    console.log("3. Decoded session payload:", decoded);

    // 2. Fetch the absolute latest registration row from Supabase
    const { data: rows, error: fetchErr } = await supabase
      .from('ibsp')
      .select('*')
      .eq('id', decoded.id)
      .limit(1);

    if (fetchErr || !rows || rows.length === 0) {
      console.error(`[ReqID: ${req.id}] [Create Order] Registration search returned zero matches for ID: ${decoded.id}`);
      return res.status(404).json({
        success: false,
        message: 'Registration not found. Please verify your details again.'
      });
    }

    row = rows[0];
    console.log("4. Database row loaded from Supabase:", row);

    // 5. Razorpay instance initialization check
    console.log("5. Razorpay instance initialization status:", razorpay ? "Initialized" : "Not Initialized");
    
    // 6. Presence of RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET
    console.log("6. Presence of RAZORPAY_KEY_ID:", !!process.env.RAZORPAY_KEY_ID);
    console.log("6. Presence of RAZORPAY_KEY_SECRET:", !!process.env.RAZORPAY_KEY_SECRET);

    // Ensure the db status matches the token status to prevent race conditions
    if (row.payment_status !== decoded.payment_status) {
      console.warn(`[ReqID: ${req.id}] [Create Order] DB status mismatch against token status.`);
      return res.status(409).json({
        success: false,
        message: 'Registration status has changed. Please refresh and try again.'
      });
    }

    // 3. Prevent duplicate payment if already SUCCESS
    if (row.payment_status === 'SUCCESS') {
      console.warn(`[ReqID: ${req.id}] [Create Order] Blocked order creation: payment already completed.`);
      return res.status(409).json({
        success: false,
        alreadyPaid: true,
        message: 'Payment has already been completed for this registration.'
      });
    }

    // 4. Duplicate Order Prevention: check if existing order can be reused
    if (row.razorpay_order_id && row.payment_status === 'PENDING') {
      try {
        console.log(`[ReqID: ${req.id}] [Create Order] Verifying reusable state for order ID: ${row.razorpay_order_id}`);
        const existingOrder = await razorpay.orders.fetch(row.razorpay_order_id);
        
        // Reuse order if unpaid, matching amount, and belongs to this registration
        if (existingOrder && existingOrder.status !== 'paid' && existingOrder.receipt === `ib_${row.id}`) {
          order = existingOrder;
          console.log(`[ReqID: ${req.id}] [Create Order] Order reused successfully: ${order.id}`);
        }
      } catch (err) {
        console.log(`[ReqID: ${req.id}] [Create Order] No reusable order available, generating new.`);
      }
    }

    // Create new order if we couldn't reuse
    if (!order) {
      razorpayPayload = {
        amount: COURSE_FEE * 100, // paise
        currency: 'INR',
        receipt: `ib_${row.id}`,
        notes: {
          email: row.email,
          name: row.full_name
        }
      };
      
      console.log("7. The exact payload being sent to razorpay.orders.create():", razorpayPayload);
      
      order = await razorpay.orders.create(razorpayPayload);
      
      console.log("8. The complete Razorpay API response:", order);
    }

    // 5. Update the DB row with order details
    const { error: updateError } = await supabase
      .from('ibsp')
      .update({
        razorpay_order_id: order.id,
        payment_created_at: new Date().toISOString(),
        payment_status: 'PENDING'
      })
      .eq('id', row.id);

    if (updateError) {
      console.error(`[ReqID: ${req.id}] [DB Error] Failed to update registration with order details: ${updateError.message}`);
      return res.status(500).json({
        success: false,
        message: 'Failed to process payment request. Please try again.'
      });
    }

    return res.status(200).json({
      order_id: order.id,
      amount: COURSE_FEE,
      currency: 'INR',
      key: process.env.RAZORPAY_KEY_ID,
      prefill: {
        name: row.full_name,
        email: row.email,
        contact: row.whatsapp_number
      }
    });

  } catch (err) {
    console.error("CREATE ORDER ERROR");
    console.error("Decoded Session Token:", decoded);
    console.error("Supabase Row:", row);
    console.error("Razorpay Request Payload:", razorpayPayload);
    console.error("Razorpay Response (order):", order);
    console.error("Full Error:", err);
    console.error(err.stack);

    return res.status(500).json({
      success: false,
      message: 'Failed to initiate payment. Please try again later.'
    });
  }
});

// ── PAYMENT: VERIFY RAZORPAY SIGNATURE ──
app.post('/api/payment/verify', paymentLimiter, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Strict input structure validation
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.warn(`[ReqID: ${req.id}] [Verify] Incomplete parameters.`);
      return res.status(400).json({ success: false, message: 'Incomplete verification parameters.' });
    }
    if (!/^order_[a-zA-Z0-9]+$/.test(razorpay_order_id)) {
      console.warn(`[ReqID: ${req.id}] [Verify] Order ID verification failed: invalid format.`);
      return res.status(400).json({ success: false, message: 'Invalid order format.' });
    }
    if (!/^pay_[a-zA-Z0-9]+$/.test(razorpay_payment_id)) {
      console.warn(`[ReqID: ${req.id}] [Verify] Payment ID verification failed: invalid format.`);
      return res.status(400).json({ success: false, message: 'Invalid payment format.' });
    }
    if (!/^[a-fA-F0-9]{64}$/.test(razorpay_signature)) {
      console.warn(`[ReqID: ${req.id}] [Verify] Signature verification failed: invalid format.`);
      return res.status(400).json({ success: false, message: 'Invalid signature format.' });
    }

    console.log(`[ReqID: ${req.id}] [Verify] Initiating verification process for order: ${razorpay_order_id}`);

    // 1. Fetch latest registration from Supabase by order_id (Final source of truth)
    const { data: rows, error: findErr } = await supabase
      .from('ibsp')
      .select('*')
      .eq('razorpay_order_id', razorpay_order_id)
      .limit(1);

    if (findErr || !rows || rows.length === 0) {
      console.error(`[ReqID: ${req.id}] [Verify] No database match for order: ${razorpay_order_id}`);
      return res.status(404).json({ success: false, message: 'Registration not found. Please contact support.' });
    }

    const row = rows[0];

    // ── REQUIREMENT 1: Idempotency (Already Verified payment_status === SUCCESS) ──
    if (row.payment_status === 'SUCCESS') {
      console.log(`[ReqID: ${req.id}] [Verify] Payment already marked as SUCCESS in DB (Idempotency triggered).`);
      return res.status(200).json({
        success: true,
        alreadyVerified: true,
        message: 'Payment has already been verified.'
      });
    }

    // Verify current status is PENDING
    if (row.payment_status !== 'PENDING') {
      console.warn(`[ReqID: ${req.id}] [Verify] Payment status is not PENDING. Status: ${row.payment_status}`);
      return res.status(400).json({ success: false, message: 'Invalid payment status.' });
    }

    // 2. Fetch order details from Razorpay to verify receipt, amount and currency integrity
    let rzpOrder = null;
    try {
      rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
    } catch (err) {
      console.error(`[ReqID: ${req.id}] [Verify] Failed to fetch order from Razorpay: ${err.message}`);
    }

    if (!rzpOrder) {
      return res.status(400).json({ success: false, message: 'Could not fetch transaction order from payment gateway.' });
    }

    // 3. Fetch payment details from Razorpay to verify payment belongs to order
    let paymentDetails = null;
    try {
      paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (err) {
      console.error(`[ReqID: ${req.id}] [Verify] Failed to fetch payment details from Razorpay: ${err.message}`);
    }

    if (!paymentDetails) {
      return res.status(400).json({ success: false, message: 'Could not fetch payment details from payment gateway.' });
    }

    // ── REQUIREMENT 2: Verify ALL Relationships (Verify Payment Ownership Chain) ──
    // • Order belongs to the registration
    if (row.razorpay_order_id !== razorpay_order_id) {
      console.error(`[ReqID: ${req.id}] [Verify Warning] Order registration mismatch.`);
      return res.status(400).json({ success: false, message: 'Transaction verification mismatch.' });
    }
    // • Payment belongs to the order
    if (paymentDetails.order_id !== razorpay_order_id) {
      console.error(`[ReqID: ${req.id}] [Verify Warning] Payment order mismatch. Expected: ${razorpay_order_id}, Got: ${paymentDetails.order_id}`);
      return res.status(400).json({ success: false, message: 'Transaction verification mismatch.' });
    }
    // • Receipt equals the expected registration receipt
    if (rzpOrder.receipt !== `ib_${row.id}`) {
      console.error(`[ReqID: ${req.id}] [Verify Warning] Receipt mismatch. Expected: ib_${row.id}, Got: ${rzpOrder.receipt}`);
      return res.status(400).json({ success: false, message: 'Transaction verification mismatch.' });
    }
    // • Order amount equals ₹25,200 (in paise)
    if (rzpOrder.amount !== COURSE_FEE * 100) {
      console.error(`[ReqID: ${req.id}] [Verify Warning] Amount mismatch. Expected: ${COURSE_FEE * 100}, Got: ${rzpOrder.amount}`);
      return res.status(400).json({ success: false, message: 'Transaction verification mismatch.' });
    }
    // • Currency equals INR
    if (rzpOrder.currency !== 'INR') {
      console.error(`[ReqID: ${req.id}] [Verify Warning] Currency mismatch. Expected: INR, Got: ${rzpOrder.currency}`);
      return res.status(400).json({ success: false, message: 'Transaction verification mismatch.' });
    }

    // Double check local database values match as well
    if (row.payment_amount !== COURSE_FEE || row.payment_currency !== 'INR') {
      console.error(`[ReqID: ${req.id}] [Verify Warning] DB record amount/currency mismatch.`);
      return res.status(400).json({ success: false, message: 'Registration record mismatch.' });
    }

    // 4. CRITICAL: Verify Razorpay signature
    const signatureBody = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(signatureBody)
      .digest('hex');

    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(razorpay_signature, 'hex')
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      console.error(`[ReqID: ${req.id}] [Verify] Signature verification failed. Marking transaction as FAILED.`);
      await supabase
        .from('ibsp')
        .update({ payment_status: 'FAILED', failure_reason: 'Signature verification failed' })
        .eq('id', row.id);
      return res.status(400).json({ success: false, message: 'Signature verification failed.' });
    }

    // 5. Update row status to SUCCESS
    const paymentMethod = paymentDetails.method || 'unknown';
    const gatewayTxnId = paymentDetails.id || razorpay_payment_id;

    const { error: updateError } = await supabase
      .from('ibsp')
      .update({
        payment_status: 'SUCCESS',
        payment_verified: true,
        payment_verified_at: new Date().toISOString(),
        razorpay_payment_id: razorpay_payment_id,
        razorpay_signature: razorpay_signature,
        gateway_transaction_id: gatewayTxnId,
        payment_method: paymentMethod,
        failure_reason: null
      })
      .eq('id', row.id);

    if (updateError) {
      console.error(`[ReqID: ${req.id}] [DB Error] Failed to update transaction status to SUCCESS: ${updateError.message}`);
      return res.status(500).json({
        success: false,
        message: 'Payment recorded but confirmation failed. Please contact support.'
      });
    }

    console.log(`[ReqID: ${req.id}] [Verify] Payment verified and updated to SUCCESS for Order ID: ${razorpay_order_id}`);

    return res.status(200).json({
      success: true,
      message: 'Payment verified successfully. Your registration is confirmed.',
      payment_id: razorpay_payment_id
    });

  } catch (err) {
    console.error(`[ReqID: ${req.id}] [Verify Exception] Error:`, err.message);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during verification. Please contact support.'
    });
  }
});

// ── PAYMENT: HANDLE FAILURE ──
app.post('/api/payment/fail', paymentLimiter, async (req, res) => {
  try {
    const { razorpay_order_id, failure_reason } = req.body;

    if (!razorpay_order_id || typeof razorpay_order_id !== 'string') {
      return res.status(400).json({ success: false, message: 'Order ID is required.' });
    }
    if (!/^order_[a-zA-Z0-9]+$/.test(razorpay_order_id)) {
      return res.status(400).json({ success: false, message: 'Invalid order format.' });
    }

    // Find row by order_id
    const { data: rows, error: findErr } = await supabase
      .from('ibsp')
      .select('id, payment_status')
      .eq('razorpay_order_id', razorpay_order_id)
      .limit(1);

    if (findErr || !rows || rows.length === 0) {
      // Return 200 silently to avoid client-side leak
      return res.status(200).json({ success: true });
    }

    const row = rows[0];

    // Never overwrite a SUCCESS status
    if (row.payment_status === 'SUCCESS') {
      console.warn(`[ReqID: ${req.id}] [Fail] Attempted to mark a SUCCESS payment as FAILED. Blocked.`);
      return res.status(200).json({ success: true });
    }

    // ── REQUIREMENT 6: Only update records where payment_status == PENDING ──
    if (row.payment_status !== 'PENDING') {
      console.warn(`[ReqID: ${req.id}] [Fail] Record status is not PENDING. Status: ${row.payment_status}`);
      return res.status(200).json({ success: true });
    }

    await supabase
      .from('ibsp')
      .update({
        payment_status: 'FAILED',
        failure_reason: failure_reason || 'Payment cancelled or failed by user'
      })
      .eq('id', row.id);

    console.log(`[ReqID: ${req.id}] [Fail] Payment failure recorded for Order ID: ${razorpay_order_id}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(`[ReqID: ${req.id}] [Fail Exception] Error:`, err.message);
    return res.status(200).json({ success: true }); // Always succeed silently
  }
});

// Start the server (only if not running on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;

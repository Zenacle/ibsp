const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Load environment variables from the correct project root
dotenv.config({ path: path.join(__dirname, '../.env') });

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

// Serve static frontend files (for local testing)
app.use(express.static(path.join(__dirname, '..')));

// Rate limiting on registration endpoint
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Initialize Supabase
const SUPABASE_URL = 'https://hzcivmtxwrknknpsmbqr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2l2bXR4d3JrbmtucHNtYnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODM5MzcsImV4cCI6MjA5MTc1OTkzN30.jvyFw4YZzvOmIEA4szOsvbv3NxpMsBDO8CrHQKkZmfU';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── EMAIL SERVICE ──
async function sendRegistrationEmail(email, fullName) {
  console.log(`[Email Service] Sending registration confirmation to ${email} for ${fullName}...`);
  // Simulate network delay for sending email
  await new Promise((resolve) => setTimeout(resolve, 1000));
  
  if (email.includes('fail_email') || email === 'fail@example.com') {
    throw new Error('SMTP connection timed out: Failed to dispatch email.');
  }
  
  console.log(`[Email Service] Email successfully sent to ${email}`);
  return true;
}

// ── DIRECT REGISTRATION ENDPOINT ──
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { enrollmentData } = req.body;
    if (!enrollmentData || !enrollmentData.email || !enrollmentData.full_name) {
      return res.status(400).json({ error: 'Invalid enrollment data.' });
    }

    const registrationPayload = {
      full_name: enrollmentData.full_name,
      email: enrollmentData.email,
      contact_number: enrollmentData.contact_number,
      whatsapp_number: enrollmentData.whatsapp_number,
      country: enrollmentData.country,
      profession: enrollmentData.profession,
      company: enrollmentData.company,
      qualification: enrollmentData.qualification,
      batch_type: enrollmentData.batch_type,
      time_slots: enrollmentData.time_slots,
      payment_status: 'SUCCESS',
      payment_amount: 0,
      payment_currency: 'INR',
      payment_provider: 'NONE',
      payment_created_at: new Date().toISOString(),
      payment_verified: true,
      payment_verified_at: new Date().toISOString()
    };

    const { error: dbError } = await supabase
      .from('ibsp')
      .insert([registrationPayload]);

    if (dbError) {
      console.error('Failed to save registration:', dbError.message);
      return res.status(500).json({ error: 'Database error creating enrollment: ' + dbError.message });
    }

    console.log(`[Registration Success] Email: ${enrollmentData.email}`);

    // Call the email sending function and catch errors if any
    let emailSent = false;
    try {
      if (enrollmentData.email) {
        await sendRegistrationEmail(enrollmentData.email, enrollmentData.full_name);
        emailSent = true;
      }
    } catch (emailError) {
      console.error('[Email Service Error] Failed to send registration email:', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Registration completed successfully.',
      emailSent: emailSent
    });
  } catch (error) {
    console.error('[Registration Failed] Error:', error.message);
    res.status(500).json({ error: 'Failed to complete registration.' });
  }
});

// Start the server (only if not running on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;

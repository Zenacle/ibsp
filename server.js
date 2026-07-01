const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Load environment variables from the correct project root
dotenv.config({ path: path.join(__dirname, '.env') });

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

// Serve static frontend files
app.use(express.static(__dirname));

// Rate limiting on API endpoints
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || ''
});

// Initialize Supabase
const SUPABASE_URL = 'https://hzcivmtxwrknknpsmbqr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2l2bXR4d3JrbmtucHNtYnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODM5MzcsImV4cCI6MjA5MTc1OTkzN30.jvyFw4YZzvOmIEA4szOsvbv3NxpMsBDO8CrHQKkZmfU';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper function to extract gateway transaction ID from payment
function getGatewayTransactionId(payment) {
  if (!payment.acquirer_data) return '';
  return payment.acquirer_data.bank_transaction_id || 
         payment.acquirer_data.upi_transaction_id || 
         payment.acquirer_data.rrn || 
         '';
}

// ── 1. CREATE ORDER ENDPOINT ──
app.post('/api/create-order', paymentLimiter, async (req, res) => {
  try {
    const { enrollmentData } = req.body;
    if (!enrollmentData || !enrollmentData.email || !enrollmentData.full_name) {
      return res.status(400).json({ error: 'Invalid enrollment data.' });
    }

    const amountInINR = 25200; // Fixed course fee
    const amountInPaise = amountInINR * 100;
    const receipt = `receipt_ibsp_${Date.now()}`;

    // Create order on Razorpay
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: receipt
    });

    // Insert registration row before checkout (status PENDING)
    const pendingPayload = {
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
      payment_status: 'PENDING',
      payment_amount: amountInINR,
      payment_currency: 'INR',
      payment_provider: 'RAZORPAY',
      razorpay_order_id: order.id,
      razorpay_receipt: order.receipt,
      payment_created_at: new Date().toISOString()
    };

    const { error: dbError } = await supabase
      .from('ibsp')
      .insert([pendingPayload]);

    if (dbError) {
      console.error('Failed to save pending registration:', dbError.message);
      return res.status(500).json({ error: 'Database error creating pending enrollment: ' + dbError.message });
    }

    console.log(`[Order Created] ID: ${order.id}, Email: ${enrollmentData.email}`);

    res.status(200).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('[Verification Failed] Razorpay order creation failed:', error.message);
    res.status(500).json({ error: 'Failed to create payment order.' });
  }
});

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

// ── 2. VERIFY PAYMENT ENDPOINT ──
app.post('/api/verify-payment', paymentLimiter, async (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    enrollmentData
  } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required payment parameters.' });
  }

  try {
    // 5. DUPLICATE PROTECTION: Check if order is already verified successfully
    const { data: record, error: checkError } = await supabase
      .from('ibsp')
      .select('payment_status')
      .eq('razorpay_order_id', razorpay_order_id)
      .maybeSingle();

    if (checkError) {
      console.error('Database query failed during verification:', checkError.message);
      return res.status(500).json({ error: 'Verification failed: Database query issue.' });
    }

    if (record && record.payment_status === 'SUCCESS') {
      console.log(`[Verification Info] Order ${razorpay_order_id} already processed successfully. Ignoring duplicate.`);
      return res.status(200).json({ 
        success: true, 
        message: 'Registration completed successfully.',
        emailSent: true
      });
    }

    // Verify HMAC SHA256 signature
    const generated_signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generated_signature !== razorpay_signature) {
      console.error(`[Verification Failed] Signature mismatch for order: ${razorpay_order_id}`);
      
      // Update registration to FAILED
      await supabase
        .from('ibsp')
        .update({
          payment_status: 'FAILED',
          failure_reason: 'Signature verification failed'
        })
        .eq('razorpay_order_id', razorpay_order_id);

      return res.status(400).json({ error: 'Invalid payment signature verification failed.' });
    }

    // Fetch payment details from Razorpay API
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    // Double Verification checks
    if (payment.status !== 'captured' || 
        Number(payment.amount) !== 2520000 || 
        payment.currency !== 'INR' || 
        payment.order_id !== razorpay_order_id) {
      
      const reason = `Double verification mismatch. Status: ${payment.status}, Amount: ${payment.amount}, Currency: ${payment.currency}, Order: ${payment.order_id}`;
      console.error(`[Verification Failed] Double verification failed for order ${razorpay_order_id}: ${reason}`);

      await supabase
        .from('ibsp')
        .update({
          payment_status: 'FAILED',
          failure_reason: reason
        })
        .eq('razorpay_order_id', razorpay_order_id);

      return res.status(400).json({ error: 'Payment details validation failed.' });
    }

    // Update existing registration row to SUCCESS
    const updatePayload = {
      payment_status: 'SUCCESS',
      payment_verified: true,
      razorpay_payment_id: razorpay_payment_id,
      razorpay_signature: razorpay_signature,
      payment_method: payment.method,
      gateway_transaction_id: getGatewayTransactionId(payment),
      payment_verified_at: new Date().toISOString()
    };

    const { error: updateError } = await supabase
      .from('ibsp')
      .update(updatePayload)
      .eq('razorpay_order_id', razorpay_order_id);

    if (updateError) {
      console.error('Failed to update payment status to SUCCESS:', updateError.message);
      return res.status(500).json({ error: 'Database update failed: ' + updateError.message });
    }

    console.log(`[Verification Successful] Order ID: ${razorpay_order_id}, Payment ID: ${razorpay_payment_id}`);

    // Call the email sending function and catch errors if any
    let emailSent = false;
    try {
      const email = (enrollmentData && enrollmentData.email) || payment.email;
      const fullName = (enrollmentData && enrollmentData.full_name) || 'Student';
      if (email) {
        await sendRegistrationEmail(email, fullName);
        emailSent = true;
      }
    } catch (emailError) {
      console.error('[Email Service Error] Failed to send registration email:', emailError.message);
      // We do NOT mark the payment/registration as failed if only email delivery fails
    }

    res.status(200).json({
      success: true,
      message: 'Registration completed successfully.',
      emailSent: emailSent
    });

  } catch (error) {
    console.error(`[Verification Failed] Error processing verification for order ${razorpay_order_id}:`, error);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ── 8. WEBHOOK ENDPOINT ──
app.post('/api/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !webhookSecret) {
    console.error('[Payment Failed] Webhook signature or secret missing.');
    return res.status(400).json({ error: 'Webhook signature or secret missing.' });
  }

  try {
    const isSignatureValid = Razorpay.validateWebhookSignature(
      JSON.stringify(req.body),
      signature,
      webhookSecret
    );

    if (!isSignatureValid) {
      console.error('[Payment Failed] Webhook signature validation failed.');
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const event = req.body;
    console.log(`[Webhook Event Received] ${event.event}`);

    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload.payment.entity;
      const orderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;
      const amount = paymentEntity.amount;
      const currency = paymentEntity.currency;

      if (amount === 2520000 && currency === 'INR') {
        const { data: record, error: fetchError } = await supabase
          .from('ibsp')
          .select('payment_status')
          .eq('razorpay_order_id', orderId)
          .maybeSingle();

        if (!fetchError && record && record.payment_status !== 'SUCCESS') {
          await supabase
            .from('ibsp')
            .update({
              payment_status: 'SUCCESS',
              payment_verified: true,
              razorpay_payment_id: paymentId,
              payment_method: paymentEntity.method,
              gateway_transaction_id: getGatewayTransactionId(paymentEntity),
              payment_verified_at: new Date().toISOString()
            })
            .eq('razorpay_order_id', orderId);
          console.log(`[Verification Successful] Webhook marked order ${orderId} as SUCCESS.`);
        }
      }
    } else if (event.event === 'payment.failed') {
      const paymentEntity = event.payload.payment.entity;
      const orderId = paymentEntity.order_id;
      const reason = paymentEntity.error_description || 'Unknown webhook payment failure';

      console.error(`[Payment Failed] Webhook order ${orderId} failed: ${reason}`);

      await supabase
        .from('ibsp')
        .update({
          payment_status: 'FAILED',
          failure_reason: reason
        })
        .eq('razorpay_order_id', orderId)
        .catch(() => {});
    } else if (event.event === 'order.paid') {
      const orderEntity = event.payload.order.entity;
      const orderId = orderEntity.id;

      const { data: record, error: fetchError } = await supabase
        .from('ibsp')
        .select('payment_status')
        .eq('razorpay_order_id', orderId)
        .maybeSingle();

      if (!fetchError && record && record.payment_status !== 'SUCCESS') {
        await supabase
          .from('ibsp')
          .update({
            payment_status: 'SUCCESS',
            payment_verified: true,
            payment_verified_at: new Date().toISOString()
          })
          .eq('razorpay_order_id', orderId);
        console.log(`[Verification Successful] Webhook marked order ${orderId} as SUCCESS (order.paid).`);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Payment Failed] Webhook processing error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

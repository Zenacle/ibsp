-- ============================================================
-- IBSP Migration: Reset legacy SUCCESS registrations to PENDING
-- Date: 2026-07-12
-- Purpose: Previous registrations were marked SUCCESS because
--          payment was not implemented. No payments have been
--          collected. This migration resets them to PENDING so
--          they can go through the new Razorpay payment flow.
-- Safe to run multiple times (idempotent WHERE clause).
-- ============================================================

-- STEP 1: Preview records BEFORE migration (run this first)
-- SELECT id, full_name, email, payment_status, payment_provider,
--        payment_amount, payment_verified, payment_verified_at
-- FROM public.ibsp
-- ORDER BY created_at;

-- ============================================================
-- STEP 2: Run the migration
-- Only updates rows where:
--   - payment_status = 'SUCCESS'   (was set by old no-payment flow)
--   - payment_provider = 'NONE'    (confirms no real payment was made)
--   - payment_verified_at IS NOT NULL (set by old flow, means legacy)
-- This is a safe, targeted WHERE clause. It will NOT affect
-- any row that has already gone through Razorpay.
-- ============================================================
UPDATE public.ibsp
SET
    payment_status       = 'PENDING',
    payment_verified     = false,
    payment_amount       = 25200,
    payment_provider     = 'RAZORPAY',
    payment_currency     = 'INR',
    payment_verified_at  = NULL,
    payment_created_at   = NULL,
    razorpay_order_id    = NULL,
    razorpay_payment_id  = NULL,
    razorpay_signature   = NULL,
    gateway_transaction_id = NULL,
    payment_method       = NULL,
    failure_reason       = NULL
WHERE
    payment_status   = 'SUCCESS'
    AND payment_provider = 'NONE';

-- ============================================================
-- STEP 3: Verify AFTER migration
-- All rows should now show payment_status = 'PENDING'
-- ============================================================
-- SELECT id, full_name, email, payment_status, payment_provider,
--        payment_amount, payment_verified, payment_verified_at
-- FROM public.ibsp
-- ORDER BY created_at;

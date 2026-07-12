-- ============================================================
-- IBSP Migration: Normalize stored values for DB-level querying
-- Date: 2026-07-13 (revised)
--
-- normalizePhone() in JS:
--   phone.trim().replace(/[\s\-().]/g, '')
--
-- Characters removed: whitespace, hyphen, parens, dot.
-- The + prefix is KEPT (not in the regex class).
--
-- Example:  "+91 8106716033"  →  "+918106716033"
--
-- This script applies the same logic in PostgreSQL using
-- POSIX-compatible regexp_replace with the 'g' (global) flag.
-- Whitespace is matched via [[:space:]] (POSIX), not \s.
--
-- Safe to run multiple times — WHERE clause guards already-clean rows.
-- ============================================================

-- ============================================================
-- STEP 1: Preview BEFORE migration
-- Run this first to confirm the 3 rows and their current values.
-- ============================================================
-- SELECT id, full_name, email, whatsapp_number, batch_type, payment_status
-- FROM public.ibsp
-- ORDER BY created_at;

-- ============================================================
-- STEP 2: Normalize whatsapp_number and batch_type
--
-- Mirrors normalizePhone() exactly:
--   trim()                     → trim(whatsapp_number)
--   remove \s  (whitespace)   → [[:space:]]
--   remove \-  (hyphen)       → \-
--   remove (   (open paren)   → \(
--   remove )   (close paren)  → \)
--   remove .   (dot)          → \.
--   + prefix is preserved     → not in the character class
-- ============================================================
UPDATE public.ibsp
SET
    whatsapp_number = regexp_replace(
        trim(whatsapp_number),
        '[[:space:]\-\(\)\.]',
        '',
        'g'
    ),
    batch_type = trim(batch_type)
WHERE
    -- Target rows that still need normalization:
    -- has any whitespace, dash, paren, or dot in the phone number
    whatsapp_number ~ '[[:space:]\-\(\)\.]'
    -- or has untrimmed whitespace in the phone number
    OR whatsapp_number != trim(whatsapp_number)
    -- or has untrimmed whitespace in batch_type
    OR batch_type != trim(batch_type);

-- ============================================================
-- STEP 3: Verify AFTER migration
-- All whatsapp_number values should now be in +XXXXXXXXXXX format.
-- No spaces, dashes, parentheses, or dots.
-- ============================================================
SELECT
    id,
    full_name,
    email,
    whatsapp_number,
    batch_type,
    payment_status
FROM public.ibsp
ORDER BY created_at;

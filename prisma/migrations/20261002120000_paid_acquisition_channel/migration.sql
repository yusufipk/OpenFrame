-- Paid ad clicks get their own bucket instead of falling into organic GOOGLE.
ALTER TYPE "AcquisitionChannel" ADD VALUE 'PAID' AFTER 'GOOGLE';

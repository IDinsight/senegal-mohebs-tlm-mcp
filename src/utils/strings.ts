/*
 * Module: utils · internal
 *
 * Pure, dependency-free string helpers. This module imports nothing from the
 * project (a core leaf), so any layer can use it without risk of a cycle.
 */

// Strip accents/diacritics and lowercase, for accent-insensitive matching
// (e.g. comparing "leçons" and "lecons").
export const noAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Folder-safe identifier: lowercase, ascii, dash-separated. Used to normalize a
// grade or subject into the name of its sources/ folder and bucket namespace.
export const slug = (s: string) => noAccents(s).trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// First run of digits in a string as an integer, or null. Used to read a scope
// number (e.g. the chapter/week) out of a document's subfolder name.
export const firstInt = (s: string): number | null => { const m = s.match(/\d+/); return m ? parseInt(m[0], 10) : null; };

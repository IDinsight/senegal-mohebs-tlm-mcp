---
name: comment-code
description: Refactor and add concise, human-first comments to code while keeping architecture in design docs. Use when asked to comment code, add/clean up comments, write docstrings, improve code readability, or strip bloated/academic/outdated comments — for a file, a diff, or a specific code block.
---

# Code Commenting Directive

Analyze the target code and apply clear, human-intelligible, and localized comments following these strict criteria:

## Core Commenting Principles
1. **Comments Are for Human Code-Readers:**
   - Code comments exist strictly to help developers reading and maintaining this specific code file.
   - Keep comments focused on local execution context, practical intent, and immediate operational gotchas.
2. **Code Comments vs. Design Docs Boundary:**
   - Do NOT place full architectural specs, long structural rationales, or system-wide sequence descriptions inside code comments.
   - If an explanation requires high-level system design context or extensive background, link to or suggest creating an external **Design Doc**, **ADR**, or **README** section instead.
3. **Explain WHY, Not WHAT:**
   - Never write redundant comments stating obvious syntax (e.g., avoid `// increment i by 1`).
   - Focus on non-obvious business logic, edge case warnings, hardware constraints, and practical workarounds.
4. **Human-Intelligible & Grounded Language:**
   - Write in plain, direct, and pragmatic developer language. Avoid overly abstract, academic, or jargon-dense phrasing.
   - Use concrete real-world context (e.g., write `// Prevents double-charging if the user double-clicks checkout` instead of `// Enforces transactional idempotency across transient transport failures`).
5. **Document Interfaces Concisely:**
   - Add standard language-specific docstrings for public interfaces (JSDoc, PEP 257, GoDoc, Rustdoc). Keep them concise: parameters, return conditions, side effects, and thrown errors.
6. **Maintain Signal-to-Noise Ratio:**
   - Keep comments brief and readable. Remove dead code and obsolete comments. Format TODOs consistently: `// TODO(username): Description`.

## Task Execution
1. Review targeted files or code blocks.
2. Refactor existing comments that are bloated, academic, outdated, or redundant.
3. Ensure high-level design context is stripped from code comments and deferred to design docs.
4. Add clean, human-first inline context and localized interface docstrings.
5. Return the updated code directly without altering executable behavior.

/*
 * Module: server · tool group: draft lifecycle
 *
 * The curator loop, exposed as MCP tools:
 *
 *   diff_draft       — read-only. Whole-draft diff vs published. Curator +
 *                      approver only; unknown/no-role blocked.
 *   publish_draft    — approver only. Two-phase (dry-run whole-draft diff +
 *                      draft-level token → confirm promotes atomically).
 *   discard_draft    — curator or approver. Two-phase.
 *
 * All three use the active grade/subject via getActiveAdapter() (same
 * convention as list_courses, get_course, etc.) — no explicit namespace
 * arg. authorize() runs inside each underlying function, so denials never
 * leak the diff and never issue tokens. (Curriculum EDITS are the generic
 * graph verbs — add_node / move_node / reposition / set_content — registered
 * from the recipes tool group.)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asJson, guarded } from "./shared.js";
import { getActiveAdapter } from "../adapters/index.js";
import { activeWorkspace } from "../context/index.js";
import {
  diffDraft,
  publishDraftWithConfirm,
  discardDraftWithConfirm,
  kgNamespace,
  getKgStore,
  toAuditActor,
} from "../kg-store/index.js";
import { authorize } from "../authz.js";
import { currentActor } from "../actor.js";
import { randomUUID } from "node:crypto";

// Small helper: namespace for the active context. Every tool below asks for
// this the same way.
function activeNamespace(): string {
  const a = getActiveAdapter();
  return kgNamespace(activeWorkspace(), a.grade, a.subject);
}

// The active adapter's coverage hook (#13) as a plain callback for the
// subject-agnostic framework. Returns [] when the adapter declares none, so
// the framework always gets a function and never special-cases absence.
function activeCoverage(): (graph: import("../kg-store/index.js").MutationGraph) => string[] {
  const a = getActiveAdapter();
  return (graph) => a.coverageWarnings?.(graph) ?? [];
}

export function registerLifecycleTools(server: McpServer) {
  // ── diff_draft ────────────────────────────────────────────────────────────
  // Read side of the draft. Gated to curator + approver (unknown/no-role
  // callers shouldn't see WIP). Distinct from #5's per-mutation diff — this
  // is the CUMULATIVE view across every edit that has landed on the draft.
  server.registerTool(
    "diff_draft",
    {
      title: "Diff draft vs published",
      description:
        "The whole-draft diff for the active grade/subject: every node/edge that has changed on the draft compared to the currently-published version. Read-only, no state change. Distinct from the per-mutation diff you see when you dry-run an edit — this is the cumulative view an approver reads before publish_draft. Only curators and approvers may call this (a draft is pre-publish work-in-progress).",
      inputSchema: {},
    },
    guarded(async () => {
      const actor = currentActor();
      const ns = activeNamespace();
      const authz = authorize(actor, "readDraft", ns);
      if (!authz.ok) {
        // Also record the denial in the audit — same shape as every other
        // denial in the codebase (see #8's authz-enforcement.test.ts).
        await getKgStore().appendAudit({
          id: randomUUID(),
          ts: new Date().toISOString(),
          actor: toAuditActor(actor),
          namespace: ns,
          eventType: "blocked",
          reason: `unauthorized: ${authz.reason}`,
        });
        return asJson({ phase: "unauthorized", action: "readDraft", reason: authz.reason });
      }
      // Pass the active adapter's coverage hook so the whole-draft view carries
      // completeness warnings (#13) — the approver's pre-publish "this chapter
      // has no bilan" surface.
      return asJson(await diffDraft(ns, activeCoverage()));
    }),
  );

  // ── publish_draft ─────────────────────────────────────────────────────────
  // Approver only. Two-phase over the whole-draft view: dry-run shows every
  // change that will go live; confirm promotes atomically. Reuses #7's audit
  // shape (event = "publish"), records self-authorship per #8.
  server.registerTool(
    "publish_draft",
    {
      title: "Publish the draft to LIVE",
      description:
        "Promote the current draft on the active grade/subject to published — generation reads published, so this is the step that makes edits VISIBLE. REQUIRES CONFIRMATION: dry-run returns the whole-draft diff (every change since the last publish) and a confirmationToken; ask the user to approve, then call again with confirm:true and the token. Approver only. If the draft has moved since dry-run (someone else edited), the confirm is rejected — dry-run again to see the new diff. Self-authored edits are recorded on the publish audit either way; strict separation-of-duties can be enabled via TLM_ALLOW_SELF_APPROVE=0.",
      inputSchema: {
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { confirm?: boolean; confirmationToken?: string }) => {
      const ns = activeNamespace();
      // Coverage hook so the approver's dry-run shows completeness warnings and
      // the publish audit records any present at publish time (#13). Warnings
      // never block the publish.
      return asJson(await publishDraftWithConfirm(ns, { confirm: a.confirm, token: a.confirmationToken, coverage: activeCoverage() }));
    }),
  );

  // ── discard_draft ─────────────────────────────────────────────────────────
  // Curator or approver. Same two-phase shape. Nothing about published
  // changes; only the draft is thrown away. Audited (event = "discard").
  server.registerTool(
    "discard_draft",
    {
      title: "Discard the current draft",
      description:
        "Throw away the current draft on the active grade/subject. Published is untouched; only draft edits are dropped. REQUIRES CONFIRMATION: dry-run shows what will be discarded (the whole-draft diff) and returns a confirmationToken; ask the user to approve, then call again with confirm:true and the token. Curator or approver may call. If the draft moves between dry-run and confirm, the confirm is rejected.",
      inputSchema: {
        confirm: z.boolean().optional(),
        confirmationToken: z.string().optional(),
      },
    },
    guarded(async (a: { confirm?: boolean; confirmationToken?: string }) => {
      const ns = activeNamespace();
      return asJson(await discardDraftWithConfirm(ns, { confirm: a.confirm, token: a.confirmationToken }));
    }),
  );
}

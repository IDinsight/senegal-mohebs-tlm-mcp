# Getting started

Five steps before you can work: **request your access**, **install the connector** in Claude, **sign in**, learn how to **talk to the tool**, then **choose where you work** (the workspace, grade and subject).

## 1. Request your access (Supabase account)

Authentication goes through **Supabase**. There is no self-registration yet: the project administrator **creates your account**. Ask them for your access; you receive a sign-in **email** and **password**.

!!! info "No account yet?"
    Email the project administrator to have your Supabase access created. They will also pass you the connector address (step 2) if it isn't already listed in Claude.

## 2. Install the connector in Claude

The tool plugs into Claude as a **connector** named **"Teaching & Learning Materials authoring"**.

1. In Claude, open the connector settings.
2. If the **"Teaching & Learning Materials authoring"** connector is already offered by your organisation, enable it.
3. Otherwise, add a **custom connector** and paste the **address your administrator gives you** (a URL ending in `/mcp`), then confirm.

<!-- SCREENSHOT: adding the connector in Claude -->

## 3. Sign in

The first time, Claude opens a Supabase sign-in page. Enter the **email** and **password** from step 1. You won't have to do this every time.

<!-- SCREENSHOT: sign-in page -->

## 4. Talk to the tool

Once the connector is installed and you're signed in, you use the tool **by writing to Claude in plain language** — no commands to remember, no special syntax. You describe what you want, and Claude calls the right tools on the connector.

Two things that aren't obvious:

- **The connector must be active in the conversation.** In Claude, connectors are enabled per conversation. If you don't see Claude using the tool, check that **"Teaching & Learning Materials authoring"** is switched on for this chat (in the tools/connectors menu below the message box).
- **The first use asks for permission.** The very first time Claude calls a tool, it asks your permission to run it. Accept — this is normal, and it's also the safeguard that means nothing runs without your approval.

To check everything is wired up, send a simple message:

> "What can I do?"

If Claude answers using the tool (for example by listing your roles or workspaces), it's working. If it answers "from memory" without using the tool, ask explicitly:

> "Use the Teaching & Learning Materials connector to tell me what I can do."

## 5. Choose where you work

Work is always framed by three things: a **workspace**, a **grade** and a **subject**.

- The **workspace** is the big container for a programme — for example *Senegal*. It holds all the curriculums for that programme, and it is what determines your role. You only see the workspaces you have access to.
- Inside it, you work on **one grade + subject at a time** (for example *CI / mathematics*).

To see what you have access to:

> "Which workspaces can I open?"
>
> "Which grades and subjects are available?"

Then tell Claude where to go:

> "Let's work on CI mathematics in the Senegal workspace."

Claude sets the context. From then on, everything you ask applies to that scope.

!!! tip "Good to know"
    Your choice stays active for your session. If you switch subject or workspace midway, tell Claude — it starts cleanly on the new context, without mixing the two.

!!! info "Denied entry to a workspace?"
    You can only **enter** a workspace where you hold a role. If Claude tells you access is denied, ask the workspace administrator to add you (see [Administration](admin-developer.md)).

## What next?

- To build or fix the curriculum → [Create a knowledge graph](create-graph.md), [Build standards and components](build-standards.md), [Add and edit a course and its lessons](courses-lessons.md).
- To produce a document → [Generate teaching materials](create-materials.md).
- To view the curriculum → [Explore the graph](explorer.md).

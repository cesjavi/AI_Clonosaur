# Local-first privacy policy (Clonosaur)

This policy translates the "Product Principles" and privacy risks described in [ROADMAP.md](ROADMAP.md) into concrete rules the app must follow.

## 1. Local processing by default

- All gathering, parsing, normalization, indexing, and initial analysis of your data happens on your computer.
- The database (SQLite), imported files, and embeddings are stored locally, not on a server.
- There is no cloud sync in the MVP.

## 2. Nothing leaves without your explicit approval

- No raw data (messages, contacts, files) is automatically sent to an external service.
- If in the future you enable "hybrid mode" (optional use of an external LLM), the app shows you the exact text fragment that will be sent before sending it, and needs your confirmation every time.
- When possible, hybrid mode offers to anonymize or summarize the content before showing you the send preview.

## 3. Full control over your own memory

- You can review, edit, exclude, or delete any saved memory, profile trait, or interview answer.
- You can delete data by source, by contact, or by date range.
- Deletion is real: it removes the records from the local database, it doesn't just hide them in the interface.

## 4. Third-party data

- Your conversations contain messages from other people. Those messages are processed locally just like yours, but:
  - The app clearly separates what you said from what third parties said (`is_user` on each message).
  - You can exclude an entire contact from the clone's memory.
  - Messages are classified by sensitivity to flag potentially delicate content.

## 5. The clone's identity

- You can only create a clone of yourself, unless another person gives verifiable consent for a clone of them to be created.
- The clone never presents itself as a real human being to third parties.
- There is no automatic sending of messages to third parties on the user's behalf; any "as me" drafting requires human approval before being sent (see later roadmap phases, "Personal Copilot").

## 6. Auditability

- Every clone response based on memory must be able to show the sources (messages, interview answers) that back it up.
- The agent must state uncertainty ("I don't know") when it doesn't have enough evidence, instead of making things up.

## 7. What the app does not do in the MVP

- It doesn't use official WhatsApp/Gmail/etc. APIs to extract data automatically; it only processes exports that you import manually.
- It doesn't send messages to third parties autonomously.
- It doesn't create clones of other people without their explicit consent.
- It doesn't sync anything to its own or third-party servers.

This policy will be updated as the roadmap progresses toward phases with direct integrations or hybrid mode, and any change that reduces the scope of these guarantees must be explicitly documented here.

/**
 * Bundled Layer-2 anchor exemplars (add-semantic-routing). Curated prompts
 * whose centroids define the `high` (reasoning-heavy, escalation-worthy) and
 * `low` (quick, cheap-passable) bands. These seed the classifier at boot: each
 * exemplar is serialized through the SAME extractor as live requests, embedded
 * once, and averaged into a per-band centroid.
 *
 * The set is VERSIONED — `ANCHOR_SET_ID` is part of the classifier revision
 * stamp, and any edit here is a new revision (the offline spike at
 * Plans/L2.md task 0.1 seeded this set: AUC 1.0 on a disjoint eval split).
 */

export const ANCHOR_SET_ID = 'bundled-v1';

export const HIGH_ANCHORS: readonly string[] = [
  'Prove that the sum of the reciprocals of the primes diverges, with full rigor.',
  'Design a multi-region active-active database architecture with conflict resolution and failover semantics.',
  'Debug this race condition: two goroutines intermittently corrupt a shared map under load; walk through the memory model.',
  'Derive the time complexity of this dynamic programming solution and prove its optimality.',
  'Write a formal security analysis of this OAuth token exchange flow, enumerating attack vectors.',
  'Refactor this legacy module into hexagonal architecture, preserving observable behavior; explain each seam.',
  'Analyze the trade-offs between CRDTs and operational transforms for a collaborative editor at scale.',
  'Implement a lock-free MPMC queue and justify every memory-ordering choice.',
  'Given these constraints, formulate the scheduling problem as an integer linear program and derive a relaxation bound.',
  'Explain how to migrate a monolith to event sourcing incrementally without downtime, with a rollback plan per phase.',
  'Diagnose why this cluster shows cascading out-of-memory kills only under p99 traffic; propose a remediation hierarchy.',
  'Compare Raft and Multi-Paxos for a geo-replicated log; prove safety under partition for your recommendation.',
  'Write a compiler pass that performs escape analysis and explain the soundness argument.',
  'Model the epidemiological dynamics with an SEIR system and fit parameters to this dataset; discuss identifiability.',
  'Architect a zero-downtime schema migration for a large table with foreign keys and triggers.',
  'Evaluate whether this cryptographic protocol is forward-secret; construct an attack if not.',
  'Optimize this GPU kernel for memory coalescing and occupancy; show the roofline analysis.',
  'Draft a step-by-step proof of the Church-Rosser theorem for the untyped lambda calculus.',
  'Given conflicting stakeholder requirements, produce a weighted decision matrix and defend the ranking.',
  'Reverse-engineer the failure mode from these stack traces across three services and reconstruct the causal chain.',
  'Design an exactly-once stream processing topology with idempotent sinks; enumerate failure windows.',
  'Explain quantum error correction with surface codes to a graduate audience, including threshold theorems.',
  'Build a cost model for this query planner and show where the cardinality estimates break down.',
  'Analyze this contract clause for ambiguity and draft three alternative formulations with risk notes.',
  'Construct a differential diagnosis for these symptoms and lab values, ranked by likelihood with reasoning.',
  'Plan a strangler-fig migration off a mainframe batch system, sequencing by risk and data dependencies.',
  'Derive the backpropagation equations for this custom attention variant and check gradient shapes.',
  'Write a threat model for a self-hosted password manager, covering supply chain and side channels.',
  'Formulate an optimal control policy for this inventory system with stochastic demand; justify with dynamic programming.',
  'Design a rate limiter that is fair across tenants, resilient to clock skew, and correct across instances; prove bounds.',
];

export const LOW_ANCHORS: readonly string[] = [
  'What time zone is Tokyo in?',
  'Convert 72 fahrenheit to celsius.',
  'Write a haiku about coffee.',
  'What is the capital of Portugal?',
  'Reword this sentence to sound friendlier: "Send me the file now."',
  'List five common fruits.',
  'What does HTTP stand for?',
  'Give me a synonym for "happy".',
  'How do I say thank you in Japanese?',
  'Format this date as ISO: March 5, 2026.',
  'What year did the Berlin Wall fall?',
  'Make this uppercase: hello world',
  'Suggest a name for a goldfish.',
  'What is 15% of 80?',
  'Spell "necessary" correctly.',
  'Give me a one-line summary of Romeo and Juliet.',
  'Is a tomato a fruit or a vegetable?',
  'Write a two-sentence thank-you note for a gift.',
  'What is the plural of "cactus"?',
  'Round 3.14159 to two decimals.',
  'Name the days of the week in French.',
  'What color do blue and yellow make?',
  'Give me a fun fact about penguins.',
  'How many ounces in a pound?',
  'What is the chemical symbol for gold?',
  'Turn this into a bullet list: apples, pears, plums.',
  'Who wrote Pride and Prejudice?',
  'Wish my coworker a happy work anniversary in one line.',
  'What is the square root of 144?',
  'Translate "good morning" to Spanish.',
];

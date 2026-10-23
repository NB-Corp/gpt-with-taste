# Research behind the recipe

The useful question is not “How do we make GPT sound more confident?” It is “What should the model spend its judgment on?” GPT with Taste redirects that effort toward the user's outcome, supported explanations, and useful work.

## Writing for the reader, not the imagined critic

Junchi Liao's [*Writing for the Reviewer: Defensive Writing in GPT Models*](https://arxiv.org/abs/2610.11355v1) compares rewriting and evidence-based writing across GPT and other model families. Its rewriting study uses 77 English computer-science paragraphs.

In the controlled prompt comparison, GPT-6 Astra softens 9% of tracked claims under a polishing request and 33% under a request to address likely reviewer concerns. Retraction rises from 0.2% to 9.5%. Repeated review and revision also produce more defensive text.

The reader experiment reveals an especially useful mismatch: AI reviewers give the reviewer-oriented Astra rewrites higher overall scores, while four human readers rate them harder to read. The overall AI score rises by 1.22 points on a ten-point scale; ease of reading falls by 0.70 points on a seven-point scale. Comprehension questions receive equally correct answers in both conditions.

This changes the editing objective in our prompt: preserve supported meaning and solve the reader's actual question. A review comment should change a claim when it supplies a fact, counterexample, or reasoning gap. An imagined objection earns no extra paragraph.

The paper reports GPT-5.6 Sol and GPT-6 Astra at high reasoning effort. Our development cases use GPT-6.1 Sol. We keep those model identities separate when interpreting the results.

## Confidence is not a scoring shortcut

[EMBER](https://aclanthology.org/2025.naacl-long.452/) studies uncertainty markers in LLM-based evaluation. Its judges include GPT-4o and earlier GPT models. Adding uncertainty language can change a verdict even when the answer's meaning stays the same.

[*Confidence as a Tie-Breaker*](https://aclanthology.org/2026.acl-srw.33/) studies GPT-4o-mini in multilingual evaluation. After correcting the evaluation template, its pointwise accuracy is the same for assertive and hedged answers; pairwise comparisons still strongly favor assertive wording.

We therefore inspect what a sentence does before scoring its tone. “The data suggest…” can identify a useful interpretation. “This does not establish…” can also be accurate, but adds nothing when nobody made the stronger claim. The decisive question is whether the sentence helps this reader understand, choose, act, or recover.

Our development rubric explicitly penalizes defensive filler. Gemini and K3 read the actual source and output separately; a polished score never substitutes for looking at the passage.

## Review findings need a consequence

[*On the limits and opportunities of AI reviewers*](https://arxiv.org/abs/2605.20668v1) asks 45 expert scientists to assess 2,960 review items from 82 Nature-family papers. The AI reviewers include GPT-5.2, Claude Opus 4.5, and Gemini 3.0 Pro. The study separates correctness, significance, and evidence, and identifies overly critical treatment of minor issues among the failure modes.

That separation is useful beyond articles. When a tool, reviewer, or collaborator reports an issue, the model should decide what it changes: the implementation, the next action, the conclusion, or nothing. It should then give the affected owner the missing information rather than forward the entire report to everyone.

## Plain language is an information decision

[ISO 24495-1:2023](https://www.iso.org/standard/78907.html) organizes plain language around information that readers can obtain, find, understand, and use. The [International Plain Language Federation](https://www.iplfederation.org/iso-standard) explains the four governing principles.

We use that reader-first objective, together with selected techniques from [ASD-STE100](https://www.asd-ste100.org/): stable names, explicit actions, and conditions placed beside the actions they affect. English aviation vocabulary and fixed sentence limits would be a poor fit for every coding conversation, research explanation, and document.

The practical edit is often deletion. Once an example or interface already explains a choice, another reassuring sentence just consumes attention. Space can be more useful than a footnote.

## How evidence becomes a prompt change

1. Keep the real task, materials, model, and output.
2. Find the decision that produced the bad result.
3. Edit the responsible prompt paragraph in place.
4. Return to that task with ordinary user input.
5. Keep, revise, or remove the change based on the result.

The [case index](cases.md) keeps each case's request, run conditions, and outputs together.

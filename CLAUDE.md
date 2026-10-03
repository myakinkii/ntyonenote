You are an agent helping in building hybrid app - an alternative ms OneNote client in win98 style.

## Git — don't stage or commit

Never run `git add` or `git commit` unless explicitly asked to in that
turn. The user stages files themselves as work lands, specifically so they
can review the in-progress diff — staging anything preemptively (even just
to inspect it yourself) gets in the way of that.

## Editing philosophy — less is more

When asked to remove something (a reference, a field, a paragraph), just remove it —
don't replace it with new explanatory text, examples, or elaboration to compensate. A
trimmed edit should end up shorter, not restructured into a longer one making the same
point a different way.

## Questions mean answer, not action

When a message is phrased as a question ("how would X perform?", "what do
you think about Y?"), give an answer — analysis, opinion, prediction. Don't
follow it with unprompted action (running a test, making the change, etc.)
in the same turn. Wait for explicit confirmation before acting on it, even
if the action would just as easily settle the question empirically.

Symmetric in the other direction: answering a clarifying question you asked (e.g. via AskUserQuestion)
mid-task authorizes resuming the standing plan, not a separate "report
before acting" checkpoint the user asked for — that still needs its own
explicit go-ahead.
Answering one (or more) narrow embedded question is not blanket approval for a broader plan.

## Stay within what was asked

Authorization for X isn't authorization for Y and Z too, even if helpful.
# The rubric file

The Grading tab (grader mode) and `logic-game grade` grade with a *rubric*: the items to score,
how the scores make a grade, the thresholds for the suggested scores, and the standard comments.
By default they use the rubric of the logic game assignment (`DEFAULT_RUBRIC` in
`js/grading.js`). For another assignment, download it in the Grading tab (*The rubric* >
*Download the rubric (.json)*), change it, and load it again (*Load a rubric…*), or pass it to the
command-line version with `--rubric FILE`.

A rubric is a JSON file. JSON has no comments, so the default rubric is shown below with
comments (`//`) added; leave them out in a real file.

```js
{
  "format": "logic-game-rubric",   // what kind of file this is (a file with another format is refused)
  "format_version": 1,
  "title": "Knowledge Representation and Reasoning 2026 — Homework 3, Exercise 1",
                                    // the course and assignment: at the top of every feedback document

  "required": {                     // the items that every passing game must meet
    "grade": 6,                     // the grade when all of them are met (and no extra item is)
    "items": [
      { "id": "timing",
        "label": "Level generation and execution of the game (with the strategy) run in a matter of seconds",
        "check": "timing" },
      { "id": "novel", "label": "The game is novel (in some way)", "check": "novelty" },
      { "id": "documented", "label": "The answer set programs are properly documented with comments",
        "check": "comments" }
    ]
  },

  "extra": {                        // items that raise the grade with points
    "max": 9,                       // the grade is never higher than this ...
    "all_grade": 10,                // ... except when all extra items get all their points: then this grade
    "items": [
      { "id": "visual", "label": "The game is visually pleasing", "points": 0.5, "check": "visual" },
      { "id": "hidden", "label": "Some (important) elements in the game are not observable to the player",
        "points": 1, "check": "hidden" },
      { "id": "npc", "label": "The game involves moving NPCs (non-playable characters)", "points": 1, "check": "npc" },
      { "id": "random", "label": "Level generation involves randomness", "points": 0.5, "check": "random" },
      { "id": "new_levels", "label": "The solution works for newly generated levels", "points": 0.5,
        "check": "new_levels" },
      { "id": "memory", "label": "Solving the game involves the memory feature", "points": 1, "check": "memory" }
    ]
  },

  "checks": {                       // thresholds for the suggested scores (see "The checks" below)
    "test_levels": 20,              // levels played by Test and measure (and by logic-game grade)
    "generation_seconds": 5,        // level generation may take this long ...
    "step_seconds": 2,              // ... and one program in one step this long
    "min_comment_ratio": 0.15,      // comment lines per code line, in every program
    "min_win_rate": 0.9,            // "works for new levels" from this share of won levels on ...
    "low_win_rate": 0.5,            // ... and certainly not below this share
    "similar": 0.8,                 // a game at least this similar to another game is a near-copy ...
    "different": 0.5,               // ... and below this it is clearly different
    "player_objects": ["player"]    // the objects that are the player (other objects that move are NPCs)
  },

  "snippets": [                     // the standard comments, inserted into a comment with one click
    "Well done: the game works, and the strategy wins reliably.",
    "Some of the programs have (almost) no comments: explain what the rules do.",
    "..."
  ]
}
```

## The fields

- **`format`**: always `"logic-game-rubric"`. A file without it is read as a rubric too; a file with
  another format (such as a grading file) is refused.
- **`format_version`**: `1`. (It is written, but not checked when a rubric is read.)
- **`title`**: the course and assignment. It is the heading of every feedback document, and shown
  above the rubric in the Grading tab. May be empty.
- **`required.grade`**: the grade when all required items are met (default 6).
- **`required.items`**: the items that a game must meet to pass. In the Grading tab each one is
  *met* or *not met*; they have no points.
- **`extra.max`**: the highest grade that the points of the extra items can give (default 10).
- **`extra.all_grade`**: the grade when *all* extra items are scored *yes* with all their points
  (default: none, then `max` is the highest grade). With the default rubric, all extra items give a
  10, while any other combination gives at most a 9.
- **`extra.items`**: the items that add points.
- **`checks`**: the thresholds of the suggestions. Values that are left out get the defaults above,
  so a rubric can give only the ones it changes.
- **`snippets`**: the standard comments. When they are left out, the default ones are used. Changing
  the standard comments in the Grading tab (*Change the standard comments*) changes them in the rubric
  of the grading session (they are then also in an exported grading file).

Every item has:

- **`id`**: a short name, unique in the rubric. The scores of a student are kept by this id, and it is
  the name of the item's column in `grades.csv` (so do not change the ids of a rubric halfway through
  grading). Without an id, an item gets `required_1`, `extra_2`, ... (by its place in the list).
- **`label`**: the text of the item, as the grader and the student see it (required).
- **`points`** (extra items only, required, more than 0): what the item adds to the grade when it is
  scored *yes*. The grader can give fewer points (in steps of 0.25, between 0 and `points`); left
  empty, the item gets all its points.
- **`check`** (optional): which measurement suggests a score for the item (see below). Without a
  check, the item gets no suggestion: the grader decides.
- **`description`** (optional): kept with the rubric, but not shown anywhere yet.

## How the grade is computed

`compute_grade` in `js/grading.js`:

1. If any required item is *not met*, there is no computed grade: the grader gives the grade
   (*Give another grade* in the Grading tab).
2. Otherwise the grade is `required.grade` plus the points of the extra items that are scored *yes*,
   but at most `extra.max`.
3. If all extra items are scored *yes* with all their points, and `extra.all_grade` is set, the grade
   is `extra.all_grade` instead.
4. As long as an item is not decided, the grade is shown as "so far" (and in brackets in the list of
   students), and it is not final: `grades.csv` leaves it empty.
5. *Give another grade* overrides all of this: that grade counts, whatever the scores are.

With the default rubric: all required items met and the extra items *hidden* (1), *npc* (1) and
*random* (0.5) give 6 + 2.5 = 8.5; all extra items but one give at most 9; all of them give 10.

## The checks

What each `check` suggests (`suggest` in `js/grading.js`), after *Test and measure* (or
`logic-game grade`). A suggestion is *yes* (*met* for a required item), *no* (*not met*), or none
(the grader decides); it always comes with the evidence. *Accept the suggestions* fills in only the
items that the grader did not decide yet.

| `check` | What it looks at | Suggests |
| --- | --- | --- |
| `timing` | How long level generation took (the longest of all levels), and the longest time of one program in one step | *yes* when level generation took at most `generation_seconds` and every program at most `step_seconds` in a step; *no* when clingo was stopped (its time limit, 10 seconds by default) in some level; otherwise none (judge whether it impedes game play) |
| `novelty` | The similarity to the example games and the other submissions (the programs without comments and spaces, with every variable written as `V`; the Jaccard index of runs of five tokens) | *no* when the most similar game is at least `similar` alike; *yes* when it is less than `different` alike; none in between |
| `comments` | Comment lines per code line, for every program that has code | *no* when a program with 3 or more code lines has no comment at all; *yes* when every program has at least `min_comment_ratio`; none otherwise |
| `visual` | The labels, icons, colors and background colors that the game uses | never a suggestion: the grader decides (the counts are the evidence) |
| `hidden` | Which objects of the game state the player did not observe, in how many steps | *yes* when some object was not seen in some step; *no* when the player saw every object in every step |
| `npc` | Which objects moved; the objects named in `player_objects` are the player | *yes* when an object that is not the player moved (when none of the objects that moved is named in `player_objects`: when more than one object moved); *no* otherwise |
| `random` | How many different levels were generated (and whether level generation uses `RANDINT`) | *yes* when more than one different level was generated; *no* when all levels were the same (with more than one level played) |
| `new_levels` | The share of the `test_levels` new levels that the strategy won | *yes* from `min_win_rate` on; *no* below `low_win_rate`; none in between |
| `memory` | Whether the strategy derives `remember/1`, reads `memory/1`, and whether the memory was not empty while playing | *no* when the strategy never derives `remember/1`, or nothing was remembered while playing; *yes* when it remembers and uses its memory (judge whether solving the game involves it); none when it remembers but never reads `memory/1` |

`test_levels` is the number of levels played by *Test and measure* (it can be changed for one
student next to the button) and by `logic-game grade` (also `--levels N`). Levels 1 to *n* are
played exactly as levels 1 to *n* of *Test your strategy*.

## Errors when loading a rubric

A rubric is refused, with the reason, when it is not valid JSON, has another `format`, has required or extra
items that are not a list, has an item without a label, two items with the same id, an extra item
without points, a check that does not exist, or grades that are not numbers.

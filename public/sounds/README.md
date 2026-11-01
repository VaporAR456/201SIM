# Match sounds

Drop the field sounds here with these names (`.mp3`, `.wav` or `.ogg`). Any that are missing
use a built-in stand-in tone.

| File | When it plays |
|---|---|
| `start` | match start (after the 3-2-1 countdown) |
| `auto-end` | end of AUTO |
| `teleop` | TELEOP starts (TRANSITION SHIFT) |
| `shift` | each HUB switch (SHIFT 1 to 4) |
| `endgame` | END GAME starts |
| `end` | final buzzer |

Shooter sounds (flywheel, shots) are generated live in `src/sound.js`.

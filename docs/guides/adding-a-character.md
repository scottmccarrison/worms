# Adding a character (worm skin)

A "character" is a worm visual identity — sprite, voice pack, hat options. All characters share the same physics body + game behavior; only visuals differ. Teams pick a character in the lobby.

## 1. Author the Aseprite file

Canvas size: 48x48 per frame (pixel art; sprites scale up in rendering).

**Required animations** (Aseprite tags):

| Tag | Frames | Loop | Notes |
|---|---|---|---|
| `idle` | 4 | yes | small idle bob |
| `walk` | 6 | yes | 2-direction; horizontal flip handled at render time |
| `jump` | 3 | no | anticipation + airborne + land |
| `aim` | 4 | no | rotate with aim angle (frames are angle steps) |
| `fire` | 2 | no | firing pose, plays then transitions back |
| `damage` | 3 | no | flinch + flash |
| `death` | 5 | no | knockout animation |
| `celebrate` | 6 | yes | winner animation |

Each tag is marked in Aseprite's tag panel (bottom-right of the animation timeline). The exporter includes tag metadata in the JSON.

**Export** (`File -> Export Sprite Sheet`):

- Layout: Packed
- Output File: `ninja.png`
- JSON Data: `ninja.json` (Array format)
- Meta: include Tags

Save to:

```
public/assets/characters/
  ninja.png
  ninja.json
```

## 2. Register

`src/characters/index.ts`:

```ts
export const CHARACTERS = {
  ninja: {
    id: "ninja",
    name: "Ninja",
    description: "Dark and mysterious.",
    atlas: "ninja",
    voicePack: "ninja",    // see audio guide; optional
    unlockRule: "default", // or "achievement:first-win" etc.
  },
  default: {
    id: "default",
    name: "Recruit",
    atlas: "default",
    voicePack: "default",
    unlockRule: "default",
  },
} as const;

export type CharacterId = keyof typeof CHARACTERS;
```

## 3. Loader

`src/loaders/characters.ts`:

```ts
for (const c of Object.values(CHARACTERS)) {
  scene.load.atlas(c.atlas, `assets/characters/${c.atlas}.png`, `assets/characters/${c.atlas}.json`);
}
```

## 4. Hat / accessory slots

Hats are a separate atlas rendered on top of the character sprite, anchored to a specific frame offset.

```
public/assets/hats/
  top-hat.png
  top-hat.json    # includes anchor offsets per animation frame
```

Anchors are set in the hat JSON: `{ frame: "walk-0", x: 24, y: 4 }`. The render system places the hat sprite at (character.x + anchor.x, character.y + anchor.y) every frame.

Skip hats in v1; add in Epic 23 (team customization).

## 5. Voice pack (optional; defer to later epic)

`public/assets/voice/ninja/` contains line clips played on events:

- `hello.ogg`, `hit.ogg`, `miss.ogg`, `death.ogg`, `win.ogg`

Voice pack config in `src/characters/voice.ts` maps events to clip names. Optional for MVP.

## 6. Test

```sh
npm run dev
```

Start local game, in lobby select your character, start round. Verify all animations play correctly at the right times:

- `idle` when worm is not active
- `walk` when walking
- `jump` when jumping
- `aim` when holding aim
- `fire` on weapon fire
- `damage` on hit
- `death` on elimination
- `celebrate` on round win

## Reproducibility

Once the character system exists (Epic 4 + 23), adding a new character is:

1. One Aseprite file with named tags
2. One entry in `CHARACTERS`
3. Done.

No code changes to game logic — the renderer picks up the new atlas automatically via the registry.

## Checklist

- [ ] Aseprite file with all required animation tags
- [ ] Exported atlas + JSON at `public/assets/characters/<id>/`
- [ ] Registered in `src/characters/index.ts`
- [ ] Tested: all animation states fire on correct events
- [ ] Voice pack (optional, later)
- [ ] NOTICE updated if assets are CC-BY

Typical effort: 4-8 hours of pixel art per character + 15 min of config.

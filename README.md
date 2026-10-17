# Tram Racer

A silly tram race through Melbourne that runs in a web browser. You (in a green-and-cream **W class**) race the CPU (in a modern **G class**) down two parallel tracks. First you both have to run to your trams.

## How to play

1. Press **Enter**, **Space**, or tap the game to start.
2. After the countdown, **hold → (or D) to run** to your tram. You jump aboard when you reach the door.
3. On the tram you can only go forwards:
   - **→ / D** (or ↑ / W) powers the tram.
   - **← / A** (or ↓ / S) brakes.
   - On an iPhone or iPad (or with the mouse), tap or hold anywhere on the **right half** of the screen for → and the **left half** for ←. The POWER and BRAKE pedals in the corners show what you're pressing. Turn a phone sideways for the biggest view.
4. Watch out for:
   - **Curves** (yellow chevrons, "40" signs): go over 40 km/h and you derail.
   - **Road crossings**: when the light by your track is red, a car is about to cross. Stop, or hit it.
5. Each race has its own soundtrack: upbeat lofi made live in the browser, in a random key and tempo with new variations every bar, so no two races sound the same. The tram bell rings at most once a minute. Press **M** to turn the music off or on. The speaker button in the top-right corner opens a volume slider for all the game's sound (music and effects); drag it with a finger or the mouse, and the game remembers it.
6. Cheerleaders and a mix of male and female spectators, spread out along the route, cheer you on (one of them thinks this game is silly), and TV news crews cover the start and the finish. First tram past the finish wins.
7. Every race is different: the track is 1.4 to 2.8 km long, and the curves, crossings and crowd move around. Keep an eye on the sky, too.

## Running it

There is no build step. Open `index.html` in a browser, or serve the folder with any static server, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

All paths are relative, so it also works from GitHub Pages under a subpath.

## Files

- `index.html`: the page and canvas.
- `game.js`: the whole game (plain JavaScript, HTML5 canvas, Web Audio for sound).
- `music.js`: the Racing Trams soundtrack, synthesized with the Web Audio API (no audio files).

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
5. Cheerleaders and a mix of male and female spectators, spread out along the route, cheer you on, and TV news crews cover the start and the finish. First tram past the finish wins.

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

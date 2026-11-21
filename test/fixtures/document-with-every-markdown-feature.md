# Building a trim box for a flight stick

This guide walks through making a **small trim controller** that plugs into a joystick, with *short notes* along the way, `inline code` for commands, ~~an old approach~~ that no longer works, a [link to the vendor docs](https://example.com/docs), and <kbd>Ctrl</kbd> shortcuts. After all that inline markup, the paragraph carries on with plain words.

## What you need

- a microcontroller board,
- two rotary encoders, and
- a small enclosure.

1. Solder the headers.
2. Connect the encoders.
3. Flash the firmware.

- [x] Order the parts
- [ ] Print the case

- Top level wiring step
  - Nested wiring step
    - Deepest wiring step

### Wiring it up

> Double check the polarity before you
> connect the power to the board.

```cpp
void setup() {
  Serial.begin(9600);
}
```

| Pin | Purpose     |
| --- | ----------- |
| A0  | Pitch trim  |
| A1  | Rudder trim |

---

![The finished box](./image.png)

[![A photo that links to the shop](./image.png)](https://example.com/shop)

<img src="./image.png" alt="A smaller photo" style="width: 50%" />

The photos above show the assembled enclosure from three angles.

<details>
<summary>Troubleshooting</summary>

If the device does not show up, try a different cable.

</details>

#### Testing the device

Selecting "properties" should show all the axes and buttons, and behave exactly as you'd expect.

##### Notes on the build

Closing notes go in this paragraph.

###### Credits and thanks

Written by the project team.

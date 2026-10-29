# Fonts

Bundled so text renders the same everywhere. All are under the SIL Open Font License 1.1, which allows bundling them with owl and using them in any video.

| File | Text font | Font | Source | License |
| --- | --- | --- | --- | --- |
| `InterDisplay-Black.otf`, `InterDisplay-Bold.otf`, `InterDisplay-Light.otf`, `Inter-SemiBold.otf` | sans, display, light | Inter 4 | https://github.com/rsms/inter | `OFL-Inter.txt` |
| `InstrumentSerif-Regular.ttf`, `InstrumentSerif-Italic.ttf` | serif | Instrument Serif | https://github.com/google/fonts/tree/main/ofl/instrumentserif | `OFL-InstrumentSerif.txt` |
| `CormorantGaramond-Medium.ttf`, `CormorantGaramond-Bold.ttf` | classic | Cormorant Garamond | https://github.com/google/fonts/tree/main/ofl/cormorantgaramond | `OFL-CormorantGaramond.txt` |
| `BebasNeue-Regular.ttf` | condensed | Bebas Neue | https://github.com/google/fonts/tree/main/ofl/bebasneue | `OFL-BebasNeue.txt` |
| `SpaceGrotesk-Medium.ttf`, `SpaceGrotesk-Bold.ttf` | grotesk | Space Grotesk | https://github.com/google/fonts/tree/main/ofl/spacegrotesk | `OFL-SpaceGrotesk.txt` |
| `IBMPlexMono-Medium.ttf`, `IBMPlexMono-SemiBold.ttf` | mono | IBM Plex Mono | https://github.com/google/fonts/tree/main/ofl/ibmplexmono | `OFL-IBMPlexMono.txt` |

Cormorant Garamond and Space Grotesk ship upstream only as variable fonts. libass picks fonts by name, so the weights above are static instances made with fontTools:

```sh
fonttools varLib.instancer "SpaceGrotesk[wght].ttf" wght=500 --update-name-table -o SpaceGrotesk-Medium.ttf
```

Neither font has a Reserved Font Name, so the instances keep their names under the OFL.

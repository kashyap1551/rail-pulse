# Opportunity assessment: Rail Pulse

Answers are in my own words.

1. **What problem does this solve, in one sentence with no feature in it?**

   _Answer:_ People who follow Finland's railways, such as rail enthusiasts and transport journalists, can't tell at a glance whether trains across the whole country are running normally right now, especially during storms or strikes. (Hypothesis: not yet confirmed with real users.)

2. **Who exactly is it for: a role and a moment in their day?**

   _Answer:_ A rail enthusiast who follows Finland's railways, on a winter evening when the news reports heavy snow or a storm, opening it on their phone to see how much of the network is still moving. I'm building for enthusiasts first because I can reach and interview them in English; transport journalists are the next segment.

3. **What do they use today, and what's missing?**

   _Answer:_ Today they use VR's "On track" page (official live map plus disruption bulletins), Fintraffic's traffic-situation page and its @Rataliikenne account on X, and independent sites like Junat Kartalla and junaan.fi, which show live trains from the same open data. What's missing (my guess, not yet confirmed with users): all of these show the network right now, but none tells them whether tonight is worse than a normal evening, or by how much. A live map alone would duplicate what already exists.

4. **How often does the problem happen, and what does it cost them?**

   _Answer:_ Guess, not yet checked: disruptions an enthusiast would check for happen maybe 10–20 evenings a year, mostly November to March, plus rare strike days. The cost is low: they lose time hunting across several pages, and can't tell whether a disruption is unusual or just a normal snowy evening. It's curiosity, not money, which makes "do they care enough?" the key risk.

5. **What would success look like in 4 weeks, in numbers I can check?**

   _Answer:_ (1) I've interviewed 5 rail enthusiasts about the last disruption they followed; (2) at least 3 of the 5 say a "tonight vs a normal evening" view would answer a question they actually had; (3) the live page has run for 24 hours on GitHub Pages without an error; (4) a forum post showing it gets at least 10 replies or clicks.

6. **What must be true for this to work (valuable, usable, feasible)?**

   _Answer:_
   - Valuable: enthusiasts care whether a disruption is unusual, not just that trains exist, and they'd come back to it on bad-weather evenings.
   - Usable: on a phone, they get the answer ("worse than normal, by how much") within 10 seconds, without reading a map.
   - Feasible: the open data is enough to define "a normal evening". I believe Digitraffic also publishes each day's trains with scheduled and actual times, which could give me history without storing it myself; to check in Step 3. I can build it with plain JavaScript and Claude Code.
   - Viable: it costs nothing to run (free data, GitHub Pages) and fits the data licence (CC BY 4.0).

7. **Which of those is the riskiest assumption?**

   _Answer:_ Valuable: that enthusiasts actually want to know whether tonight is worse than normal. If they only want to see trains, the existing maps already serve them and my product has no reason to exist.

8. **What's the smallest test of that risk?**

   _Answer:_ Make one mock-up screenshot, e.g. "Tonight: 23% of trains delayed, vs 8% on a normal Tuesday evening" (example numbers, labelled as a mock-up), and show it to 5 enthusiasts on English-language rail forums. First ask about the last disruption they followed: what they checked and what they couldn't find out. Then show the mock-up and ask what they'd do with it. Pass: 3 of 5 describe a real moment it would have helped.

9. **Why now, and why me?**

   _Answer:_ Why now: the data is open and free, AI coding tools let one person build this in weeks, and November to March is disruption season, so I can test with real events this winter. Why me: I'm learning product management and want to practise the full cycle, from opportunity to shipped product; my trade and logistics studies and warehouse fulfilment work make network flow and delays my area of interest. Honest limit: I don't live in Finland and I'm not a rail insider, so I must rely on interviews, not intuition.

10. **Go, narrow or pivot?**

    _Answer:_ Narrow. A plain live map would duplicate VR's official map and independent sites like Junat Kartalla, so it isn't worth building as the product. I'll keep the same user (rail enthusiasts) and data (Digitraffic), but focus the value on one question: is the network worse than a normal evening right now, and by how much? The live map stays as v1 because it's the foundation and my learning path; the "now vs normal" comparison becomes the product's core in v2. I'll run the mock-up test (Q8) in parallel with the build.

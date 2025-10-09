Compile lines

    # To run the website locally:
            node server.js
    # or use this for auto updates when changing code
            nodemon server.js

    # and to run online we open bash terminal asw and run the line
            npx ngrok http 3000

    # and then anyone with the link it gives can open the website.


- Things to do -

High Priority


central challenge screen ✅ (partially)
remove join a room and replace with guild chat ✅
create a system admin portal to post challenge, manage points, users,  etc✅
event calendar✅
mobile compatability
create a shop where users can buy avataror, inons etc with xp points to be cool
be able to see how many people are online ✅
contact us / suggestion page 
help page
create a profile page

make sure nav bar is consistent across webpages ✅

-------CHALLENGES REVAMPP-------
actually make them useful, other thhan text chat rn, be able to upload photos, or whatever, make acc games and stuff
challenge deadlines
ongoing challenges under upcoming events so uno when challenges are ending, (the ones that last longer than a day)



Low priority


make the leaderboard look nice 
admin portal - analyse website usage
chat - filter bullshit out
background music
make sure logout isnt off the screen ✅
display username once you login ✅

<section class="card">
      <h3>Add Event</h3>
      <form method="POST" action="/admin/events/create">
        <input name="id" placeholder="challenge id (slug)" required />
        <input name="title" placeholder="title" required />
        <textarea name="description" placeholder="description"></textarea>
        <button type="submit">Create</button>
      </form>
    </section>









easter eggs

// libraries
const {google} = require('googleapis');
const OAuth2 = google.auth.OAuth2;
const express = require('express');
const ejs = require('ejs');
const expressLayouts = require('express-ejs-layouts');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cookieParser = require('cookie-parser');
const keygen = require('keygenerator');
const mysql = require('mysql');

const app = express();

// we need these for certain express routes to parse data
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(cookieParser())
app.set('view engine', 'ejs')
app.set('views', __dirname + '/views')
app.use(expressLayouts)
app.set('layout', 'layout/master')

// create my sql connection
const connection = mysql.createConnection({
    host: 'db.615283.net',
    user: 'judd_discord',
    password: '',
    database: 'jd'
});

connection.connect();

// confidential data for google and discord oauth apis
const googleClientId = '875969714164-pjrm3cu65n6njqafkt2plaoiqt7jlo4s.apps.googleusercontent.com';
const googleClientSecret = '';

const discordClientId = '719272829367091291';
const discordClientSecret = '';

// not so much a redirect url but thats how gapi works on this
const googleRedirectUrl = 'postmessage';

const oAuth2Client = new OAuth2(googleClientId, googleClientSecret, googleRedirectUrl);

// store sessions
var linkAttempts = {}

// basic static get routes
app.get('/link/google', function (req, res) {
    res.render('google');
});

app.get('/link/discord', function (req, res) {
    if (!req.cookies['link_ref']) {
        res.redirect('http://localhost:8080/link/google');
        return
    }
    res.render('discord');
});

app.get('/success', function (req, res) {
    const status = req.query['jd-status'];
    res.render('success', {
        text: status === '201' ? 'You have been added to the Discord server<br>Check Discord' :
            status === '204' ? 'You are already in the Discord server' : 'An unexpected error occurred<br>Please try again'
    });
});

// this is where discord sends our users once they have authenticated
app.get('/discordrtn', function (req, exprRes) {
    const linkRef = req.cookies['link_ref'];
    if (!linkRef) {
        exprRes.redirect('http://localhost:8080/link/google');
        return
    }
    const attempt = linkAttempts[linkRef];
    if (!attempt) {
        exprRes.redirect('http://localhost:8080/link/google');
        return
    }

    const code = req.query.code;

    // prepare request to exchange oauth code for tokens
    const data = new FormData();

    data.append('client_id', discordClientId);
    data.append('client_secret', discordClientSecret);
    data.append('grant_type', 'authorization_code');
    data.append('redirect_uri', 'http://localhost:8080/discordrtn');
    data.append('scope', 'identify guilds.join');
    data.append('code', code);

    // make said request
    fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: data
    })
        .then(res => res.json())
        .then((info) => {
            fetch('https://discord.com/api/users/@me', {
                headers: {
                    authorization: `${info.token_type} ${info.access_token}`,
                }
            }).then(res => res.json()).then(userInfo => {
                // here we have variable of all the data we have now collected, ready to insert into db
                const id = userInfo.id;
                const discordRefreshToken = info.refresh_token;

                const courses = attempt.courses
                const firstName = attempt.firstName
                const lastName = attempt.lastName
                const email = attempt.email
                const googleRefreshToken = attempt.refreshToken;

                const user = {
                    d_user_snowflake: id,
                    email: email,
                    first_name: firstName,
                    last_name: lastName,
                    d_oauth_refresh_token: discordRefreshToken,
                    g_oauth_refresh_token: googleRefreshToken,
                }

                //todo condition(s)
                connection.query('INSERT INTO users SET ?', user, function (error, results, fields) {
                    if (error && !(error.errno === 1062)) console.log(error);
                })

                for (let course of courses) {
                    const clazz = {
                        g_class_id: course.id,
                        class_display_name: course.name,
                    }
                    connection.query('INSERT INTO classes SET ?', clazz, function (error, results, fields) {
                        if (error && !(error.errno === 1062)) console.log(error);
                    })
                    const enrollment = {
                        g_class_id: course.id,
                        email: email,
                    }
                    connection.query('INSERT INTO enrollments SET ?', enrollment, function (error, results, fields) {
                        if (error && !(error.errno === 1062)) console.log(error);
                    })
                }

                // force join user to guild (Add member)
                fetch(`https://discord.com/api/guilds/718945666348351570/members/${id}`, {
                    method: 'PUT',
                    headers: {
                        // confidential bot token
                        'Authorization': 'Bot ',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        'access_token': `${info.access_token}`,
                        'nick': `${firstName} ${lastName}`
                    })
                }).then(res => {
                    // redirect to success with api res status code
                    //todo put in db
                    exprRes.redirect(`http://localhost:8080/success?jd-status=${res.status}`)
                })

            });
        })
})

// this is where google sends requests, in our case this is all in an ajax request
app.post('/auth', function (req, exprRes) {
    // cross site scripting safety
    if (req.header('X-Requested-With')) {
        let code = req.body['code'];
        // checking we have code from google
        if (code) {
            oAuth2Client.getToken(code, (error, tokens) => {
                // google didnt like our request
                if (error) {
                    res.send('An error occurred during the OAuth backend stage.')
                } else {
                    // prepare oauth2client for api usage
                    oAuth2Client.setCredentials(tokens)

                    // pull classroom data
                    google.classroom({
                        version: 'v1',
                        auth: oAuth2Client
                    }).courses.list({}, (err, res) => {
                        if (err) return console.error('The API returned an error: ' + err);
                        const courses = res.data.courses;
                        google.oauth2({version: 'v2', auth: oAuth2Client}).userinfo.get(function (err, res) {
                            // pull profile data and email
                            if (err) return console.error('The API returned an error: ' + err);
                            const firstName = res.data.given_name;
                            const lastName = res.data.family_name;
                            const email = res.data.email;
                            const refreshToken = tokens.refresh_token;

                            // keygen for session cookie
                            const ref = keygen.session_id();

                            linkAttempts[ref] = {
                                firstName: firstName,
                                lastName: lastName,
                                email: email,
                                refreshToken: refreshToken,
                                courses: courses
                            }

                            // send cookie for front-end js to save to browser
                            exprRes.send(ref);
                        })
                    });
                }
            })
        } else {
            console.log('Code failure.')
        }
    } else {
        console.log('CSRF failure.')
    }
})

// start express server
// app.listen(process.env.PORT, () => console.log(`Listening on port ${process.env.PORT}`));
app.listen(8080, () => console.log(`Listening on port ${8080}`));
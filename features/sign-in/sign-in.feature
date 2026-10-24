@id:sign-in
Feature: Sign-in to the portal
  A person opens the portal in a browser and signs in with a name and a password.
  A person with an authenticator app also gives a code. Single sign-on can replace the password.
  The portal takes a new server to setup, and a person who must set up two-factor sign-in to that step first.
  The next person in the same browser never sees the data of the person before.

  Rule: Signed-out visitors sign in, then land where they were going

    Scenario: The admin opens the audit log signed out and lands on it after the sign-in
      When the admin opens the audit log while signed out
      Then the portal asks the admin to sign in
      And after the sign-in with their password, the admin sees the audit log

    Scenario: The sign-in waits for both a name and a password
      When a visitor gives only the name "admin" on the sign-in page
      Then the visitor cannot sign in yet

    Scenario: A wrong password is refused and cleared
      When the admin signs in with the password "not my passphrase"
      Then the portal says "Invalid username or password."
      And the password is empty again

  Rule: Two-factor comes after the password

    Scenario: The admin gives the password, then the current code, and lands on the audit log
      Given the admin has an authenticator app
      When the admin opens the audit log and gives their password
      Then the portal asks for the code from the authenticator app
      And after the current code, the admin sees the audit log

  Rule: Single sign-on can replace the password sign-in

    Scenario: With "Acme ID" and no password sign-in, the visitor only gets "Sign in with Acme ID"
      Given the admin set up single sign-on with "Acme ID"
      And user 12 has an SSO account, and the admin turned off the password sign-in
      When a visitor opens the sign-in page
      Then the visitor is offered "Sign in with Acme ID"
      And the visitor is not asked for a password

  Rule: The portal holds new servers and accounts at the right step

    Scenario: On a new server, every page leads to setup
      Given a new server with no accounts
      When a visitor opens the plugins page
      Then the visitor sees "Create the first admin account"

    Scenario: User 12 must set up two-factor sign-in before anything else
      Given user 12 has the role "family"
      And the admin requires two-factor sign-in for everyone
      When user 12 signs in with their password
      Then the portal says "Two-factor authentication is required"

    Scenario Outline: The sign-in page offers a new account only while sign-up is open
      Given <sign-up>
      When a visitor opens the sign-in page
      Then the visitor <offer>

      Examples:
        | sign-up                                              | offer                       |
        | the admin lets people sign up with the role "family" | can create an account       |
        | the admin has not opened sign-up                     | cannot create an account    |

  Rule: One person's data never shows to the next

    Scenario: After the admin signs out, "root" sees the user list as it is now
      Given "root" is an admin who never signed in
      And the admin saw the user list in the portal and signed out
      When "root" signs in in the same browser and opens the user list
      Then the user list shows that "root" signed in just now

  Rule: Setup checks the password as the admin types

    Scenario: A short password gets a quiet hint, spoken when the admin leaves the password
      Given a new server with no accounts
      When the admin types the password "short" on the setup page
      Then the setup page shows "Use at least 12 characters." and a screen reader hears nothing yet
      And a screen reader hears "Use at least 12 characters." once the admin leaves the password

    Scenario: A setup that someone else finished first is spoken as an alert
      Given a new server with no accounts
      And the admin opened the setup page, and someone else made the first account meanwhile
      When the admin makes the first account "admin" with the password "correct horse battery"
      Then a screen reader hears the alert "Setup has already been completed"

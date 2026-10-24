@id:oauth-consent
Feature: OAuth consent
  When an app asks to sign an agent in, the person signs in on the consent page of the server.
  There the person picks the instances that the app may use, and how far it may go.

  Background:
    Given the instance "tasks" has the list "Groceries" with the open tasks "milk", "bread" and "eggs"
    And user 12 has the role "family", which has the instance "tasks"
    And the admin registered the app "Acme Chat"

  Rule: The person signs in on the consent page

    Scenario: User 12 signs in with a password and sees what the app asks for
      When user 12 opens the sign-in of "Acme Chat" and gives their password
      Then user 12 sees "Authorize Acme Chat", the return host "127.0.0.1:9" and the instance "tasks"

    Scenario: User 12 with an authenticator app is asked for a code
      Given user 12 has an authenticator app
      When user 12 opens the sign-in of "Acme Chat" and gives their password
      Then user 12 is asked for a code from their authenticator app, and sees no consent yet

    Scenario: User 12 must set up an authenticator app first when the admin requires two-factor sign-in
      Given the admin requires two-factor sign-in for everyone
      When user 12 opens the sign-in of "Acme Chat" and gives their password
      Then user 12 is told to set up their authenticator app in the portal first

  Rule: Consent offers only the instances of the person

    Scenario: User 12 is offered only the instances of the role "family"
      Given Acme Tasks also runs as the instance "shopping"
      When user 12 opens the sign-in of "Acme Chat" and gives their password
      Then user 12 is offered "tasks" and not "shopping"

    Scenario: An app that asks only for instances outside the role gets nothing
      Given Acme Tasks also runs as the instance "shopping"
      When user 12 opens the sign-in of "Acme Chat" for "shopping" and gives their password
      Then user 12 is told that none of the requested instances is available to their account

    Scenario: A person whom Acme ID does not let in here is refused
      Given the admin set up single sign-on with Acme ID
      When user 12 opens the sign-in of "Acme Chat" and signs in with an Acme ID that no account has
      Then user 12 is told that their account is not allowed to sign in here

  Rule: The person picks instances, or denies

    Scenario: Approving with no instance picked asks again
      Given user 12 opened the sign-in of "Acme Chat" and gave their password
      When user 12 approves with no instance picked
      Then user 12 is asked to pick at least one instance, or to deny

    Scenario: A denial goes back to the app and is in the audit log
      Given user 12 opened the sign-in of "Acme Chat" and gave their password
      When user 12 denies the request of "Acme Chat"
      Then "Acme Chat" is told that access was denied, and the audit log shows the denial by user 12

  Rule: An app may only read, unless the person picks read and write

    Scenario: The default access is read only, also after a renewal
      Given user 12 may add tasks to "tasks" without a question
      And user 12 let agent 9 in through "Acme Chat" with the access that the page offers
      And agent 9 renews its sign-in
      When agent 9 adds "butter" to "Groceries"
      Then agent 9 is told that its credential has read-only access

    Scenario: Read and write lets the agent write
      Given user 12 may add tasks to "tasks" without a question
      And user 12 let agent 9 in through "Acme Chat" with read and write
      When agent 9 adds "butter" to "Groceries"
      Then the list "Groceries" holds the open tasks "milk", "bread", "eggs" and "butter"

  Rule: The consent form belongs to its browser

    Scenario: A consent form sent from another browser has expired
      Given user 12 opened the sign-in of "Acme Chat" and gave their password
      When the consent form of user 12 is sent from another browser
      Then the page says that the session expired, and to start again from the agent's app

    Scenario: A consent form older than 10 minutes has expired
      Given user 12 opened the sign-in of "Acme Chat" and gave their password
      And 11 minutes go by
      When user 12 approves the request of "Acme Chat"
      Then the page says that the session expired, and to start again from the agent's app

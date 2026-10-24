@id:single-sign-on
Feature: Single sign-on
  The admin can let people sign in with an identity provider, here Acme ID.
  An SSO account signs in only with Acme ID, and a local account only with its password. Nobody links one to the other.
  An identity signs in to its SSO account, or to a new one when the admin allows automatic users.
  The allow policy of the admin decides which identities may sign in at all.

  Background:
    Given user 12 has an SSO account with the role "family"
    And user 15 has a local account with the role "family"
    And the admin set up single sign-on with Acme ID

  Rule: Single sign-on works only while it is on

    Scenario: Nobody signs in with Acme ID while single sign-on is off
      Given the admin turned single sign-on off
      When user 12 signs in with Acme ID
      Then user 12 is told that single sign-on is not enabled

  Rule: The issuer and the client count only while single sign-on is on

    Scenario: Single sign-on saves as off without an issuer and a client
      When the admin saves single sign-on as off, with no issuer and no client
      Then single sign-on is off on the server, with no issuer and no client

    Scenario: Single sign-on does not turn on without an issuer and a client
      When the admin tries to turn single sign-on on, with no issuer and no client
      Then the admin is told that the issuer and the client are not valid, and single sign-on stays as it was

  Rule: An identity signs in to its SSO account

    Scenario: User 12 signs in with their Acme ID
      When user 12 signs in with Acme ID
      Then user 12 lands in the portal

    Scenario: An identity that no account has is not allowed
      When someone signs in with the Acme ID "acme-99" that no account has
      Then the sign-in with Acme ID is refused as not allowed
      And the audit log shows the refused sign-in of the Acme ID "acme-99"

    Scenario: A disabled user cannot sign in with Acme ID
      Given the admin disables user 12
      When user 12 signs in with Acme ID
      Then the sign-in with Acme ID is refused as not allowed

  Rule: The admin makes an SSO account for an address that Acme ID verifies

    Scenario: User 21 signs in with Acme ID to the account the admin made
      Given the admin made an SSO account for "user21@acme.example" with the role "family"
      When user 21 signs in with Acme ID as "user21@acme.example"
      Then user 21 lands in the portal with the role "family"

    Scenario: A changed address at Acme ID keeps the account
      Given the admin made an SSO account for "user21@acme.example" with the role "family"
      And user 21 signed in once with Acme ID as "user21@acme.example"
      When user 21 signs in with Acme ID as "u21@acme.example"
      Then user 21 lands in the same account

  Rule: Each account signs in only its own way

    Scenario: Acme ID with the address of user 15 does not sign in as user 15
      When someone signs in with Acme ID as "user15@acme.example"
      Then the sign-in with Acme ID is refused as not allowed, and nobody is signed in

    Scenario: User 12 is not asked for an app when the admin requires two-factor sign-in
      Given the admin requires two-factor sign-in for everyone
      When user 12 signs in with Acme ID
      Then user 12 lands in the portal without setting up an app

  Rule: The allow policy also binds SSO accounts

    Scenario: An SSO account outside the allowed group is refused
      Given the admin allows only the Acme ID group "mcp-admins"
      When user 12 signs in with Acme ID
      Then the sign-in with Acme ID is refused as not allowed

  Rule: An address counts only when Acme ID verified it

    Scenario: An address that Acme ID did not verify does not match
      Given the admin allows only the address "user12@acme.example"
      When user 12 signs in with Acme ID, which says that the address is not verified
      Then the sign-in with Acme ID is refused as not allowed

    Scenario: An address without a word on its verification does not match
      Given the admin allows only the address "user12@acme.example"
      When user 12 signs in with Acme ID, which says nothing about the verification of the address
      Then the sign-in with Acme ID is refused as not allowed

    Scenario: A verified address matches
      Given the admin allows only the address "user12@acme.example"
      When user 12 signs in with Acme ID
      Then user 12 lands in the portal

  Rule: An address entry is an exact address or a whole domain

    Scenario: Entries match addresses in any case
      Given the admin allows only "Admin@Example.com" and "*@corp.example"
      When user 12 signs in with Acme ID as "admin@example.COM" and then as "Anyone@CORP.example"
      Then user 12 lands in the portal both times

    Scenario: A domain entry matches no other domain
      Given the admin allows only "*@corp.example"
      When user 12 signs in with Acme ID as "a@sub.corp.example", "a@corp.example.evil.com" and "corp.example@evil.com"
      Then the sign-in with Acme ID is refused as not allowed each time

    Scenario: Entries that are neither an address nor a domain are refused
      When the admin tries to allow "*.example.com", "a*@x.com" and "*@*"
      Then the admin is told each time that the entry is not valid

  Rule: Automatic users need an allow policy and a default role

    Scenario: Automatic users without an allow policy are refused
      When the admin turns on automatic users with an empty allow policy
      Then the admin is told "Auto-provisioning needs an allow policy"

    Scenario: Automatic users without a default role make no account
      Given the admin turns on automatic users for the Acme ID group "family-members"
      When "new.person" signs in with Acme ID in the group "family-members"
      Then the sign-in with Acme ID is refused as not allowed
      And the server has no account "new.person"

  Rule: An automatic user gets the default role and a free name

    Scenario: A new person gets an account with the default role
      Given the admin turns on automatic users for the Acme ID group "family-members"
      And the default role for new users is "family"
      When "new.person" signs in with Acme ID in the group "family-members"
      Then "new.person" lands in the portal with the role "family"

    Scenario: A taken name gets a number
      Given the admin turns on automatic users for the Acme ID group "family-members"
      And the default role for new users is "family"
      And the admin made the user "new.person"
      When "new.person" signs in with Acme ID in the group "family-members"
      Then "new.person-2" lands in the portal with the role "family"

    Scenario: A name taken in other letter case gets a number
      Given the admin turns on automatic users for the Acme ID group "family-members"
      And the default role for new users is "family"
      And the admin made the user "New.Person"
      When "new.person" signs in with Acme ID in the group "family-members"
      Then "new.person-2" lands in the portal with the role "family"

  Rule: A tampered sign-in with Acme ID fails

    Scenario: A forged or expired sign-in state is refused
      When user 12 comes back from Acme ID to the consent page with a forged state, and then with a state 11 minutes old
      Then user 12 is told both times that the sign-in expired or is invalid

    Scenario: A proof made for the code step is refused
      Given user 15 has an authenticator app
      When user 15 comes back from Acme ID to the consent page with the proof of their code step as the state
      Then user 15 is told that the sign-in expired or is invalid

    Scenario: The reason of Acme ID is shown when it refuses the code
      Given Acme ID refuses every code with "the code has expired"
      When user 12 signs in with Acme ID on the consent page
      Then user 12 sees "invalid_grant: the code has expired"

    Scenario: An identity token that expired is refused
      Given Acme ID gives an identity token that expired 10 minutes ago
      When user 12 signs in with Acme ID
      Then the sign-in with Acme ID fails, and user 12 is not signed in

  Rule: Sign-in with Acme ID returns only to a page of the portal

    Scenario: User 12 comes back to the page they started from
      When user 12 signs in with Acme ID from the page "/audit"
      Then user 12 lands on "/audit"

    Scenario: A return to another site lands on the portal home
      When user 12 signs in with Acme ID from links that return to "/\attacker.example" and to a tab and "/attacker.example"
      Then user 12 lands on the portal home both times

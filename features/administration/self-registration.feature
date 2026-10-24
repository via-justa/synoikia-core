@id:self-registration
Feature: Self-registration
  The admin can let people make their own account, with a default role that the admin chooses.
  People also get an account at their first sign-in with single sign-on or through the access gateway, when the admin allows it.
  Sign-up never tells which user names exist.

  Background:
    Given user 12 has the role "family"

  Rule: Sign-up opens only with a default role and the switch

    Scenario Outline: Sign-up stays closed when <case>
      Given <setup>
      When someone signs up as "newbie@acme.example"
      Then the sign-up is refused, because the server does not accept new accounts

      Examples:
        | case                         | setup                                                |
        | the admin set nothing        | the admin has not opened sign-up                    |
        | only the switch is on        | the admin turns on sign-up without a default role    |

    Scenario: With the default role "family", a new person signs up
      Given the admin lets people sign up with the role "family"
      When someone signs up as "newbie@acme.example"
      Then "newbie@acme.example" is in the portal with the role "family", and is refused in administration

    Scenario: A default role that does not exist is refused
      When the admin tries to make "guests" the default role for new users
      Then the admin is told that there is no such role

  Rule: Sign-up closes when password sign-in is off

    Scenario: Without password sign-in, nobody signs up
      Given the admin set up single sign-on with Acme ID, and user 21 has an SSO account
      And the admin lets people sign up with the role "family"
      And password sign-in is off
      When someone signs up as "newbie@acme.example"
      Then the sign-up is refused, because the server does not accept new accounts

  Rule: Sign-up never tells which names exist

    Scenario: The name of user 12 in capitals gets the same answer as any taken name
      Given the admin lets people sign up with the role "family"
      When someone signs up as "USER12@ACME.EXAMPLE"
      Then the sign-up is refused with "Choose another username"

    Scenario: A name with a colon is refused
      Given the admin lets people sign up with the role "family"
      When someone signs up as "service:abc"
      Then the sign-up is refused, because the name breaks the user name rules

  Rule: Self-registration is recorded

    Scenario Outline: A new account through <source> is audited with its source
      Given <setup>
      When <arrival>
      Then the audit log shows that "<name>" made their own account through <source>

      Examples:
        | source             | setup                                                                    | arrival                                                             | name                     |
        | sign-up            | the admin lets people sign up with the role "family"                     | someone signs up as "newbie@acme.example"                           | newbie@acme.example      |
        | Acme ID            | Acme ID people of the group "family-members" get accounts with "family" | "new.person" signs in with Acme ID in the group "family-members"    | new.person               |
        | the access gateway | the access gateway makes accounts with the role "family"                 | "gate.person@acme.example" reaches "tasks" through the access gateway | gate.person@acme.example |

    Scenario Outline: A deleted user of <source> comes back as a new user
      Given <setup>
      And <arrival>
      And the admin deleted the user "<name>"
      When <arrival>
      Then "<name>" is a new user, with a second registration in the audit log

      Examples:
        | source             | setup                                                                    | arrival                                                             | name                     |
        | Acme ID            | Acme ID people of the group "family-members" get accounts with "family" | "new.person" signs in with Acme ID in the group "family-members"    | new.person               |
        | the access gateway | the access gateway makes accounts with the role "family"                 | "gate.person@acme.example" reaches "tasks" through the access gateway | gate.person@acme.example |

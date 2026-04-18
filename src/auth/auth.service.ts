import { forwardRef, Get, Inject, Injectable } from '@nestjs/common';
import { UsersModule } from 'src/user/user.module';
import { UsersService } from 'src/user/user.service';

@Injectable()
export class AuthService {
    constructor(@Inject(forwardRef(()=>UsersService)) private readonly userService:UsersService) {}
    isAuthenticated: Boolean=false;
    @Get()
    login(email:string, password:string) {
    //   let user = this.userService.user.find(user => user.email === email && user.password === password);
    //    if(user) {
    //     this.isAuthenticated = true;
    //     return 'Login successful' ;
    //    } else {
    //     return 'Invalid credentials' ;
    //    }
    }
}
